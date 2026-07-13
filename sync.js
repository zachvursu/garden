/* =============================================================
 * The Garden — cloud sync (Supabase).
 *
 * Offline-first: IndexedDB stays the source of truth for the UI. This layer
 * mirrors it to a shared cloud dataset so every device sees the same garden.
 *
 *  • Structured records (entries/plants/beds/supplies/kv) → `records` table.
 *  • Media (photos/audio blobs) → a Storage bucket.
 *  • Writes queue into a local "outbox" and flush when online, so nothing is
 *    lost with no signal.
 *  • Pulls are incremental (by updated_at); realtime pushes make edits on one
 *    device appear on another within a second.
 *  • Conflicts resolve last-write-wins using a client timestamp (updatedAt)
 *    embedded on each record.
 *
 * Relies on globals defined in index.html: idb/dbAll/dbGet/dbPut/dbDel,
 * reloadGarden(). Degrades to a no-op if config is blank.
 * ============================================================= */
(function () {
  "use strict";

  const RECORD_STORES = ["entries", "plants", "beds", "supplies", "kv"];
  const MEDIA_STORES = ["photos", "audio"];
  const EPOCH = "1970-01-01T00:00:00Z";

  const cfg = window.GARDEN_CONFIG || {};
  const BUCKET = cfg.MEDIA_BUCKET || "media";

  const Sync = {
    _suspend: false,      // set while applying remote changes (avoids echo loops)
    enabled: false,
    client: null,
    status: "off",        // off | offline | syncing | synced | error
  };
  window.Sync = Sync;

  /* ---------- status badge (updated in the Plan tab) ---------- */
  function setStatus(s) {
    Sync.status = s;
    const el = document.getElementById("cloud-status");
    if (el) el.textContent = statusText();
  }
  function statusText() {
    if (!Sync.enabled) return "On this device only — cloud not configured.";
    return {
      offline: "Offline — changes saved here, will sync when you're back online.",
      syncing: "Syncing…",
      synced: "Synced to the cloud ✓",
      error: "Sync issue — your data is safe on this device; retrying.",
      off: "Starting…",
    }[Sync.status] || "";
  }
  Sync.statusText = statusText;

  /* ---------- tiny local-meta helpers (own store, never synced) ---------- */
  const metaGet = async (k) => { const r = await dbGet("syncmeta", k); return r ? r.v : null; };
  const metaSet = (k, v) => dbPut("syncmeta", { id: k, v });

  /* ---------- init ---------- */
  Sync.init = function () {
    const url = (cfg.SUPABASE_URL || "").trim();
    const key = (cfg.SUPABASE_ANON_KEY || "").trim();
    if (!url || !key || !window.supabase) {
      Sync.enabled = false;
      setStatus("off");
      return;
    }
    Sync.client = window.supabase.createClient(url, key, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
    Sync.enabled = true;
  };

  /* ---------- write hooks (called from dbPut/dbDel in index.html) ---------- */
  Sync.onPut = function (store, val) {
    if (!Sync.enabled) return;
    if (RECORD_STORES.includes(store)) {
      const id = store === "kv" ? val.k : val.id;
      enqueue("rec-put", store, id);
    } else if (MEDIA_STORES.includes(store)) {
      enqueue("media-put", store, val.id);
    }
  };
  Sync.onDel = function (store, key) {
    if (!Sync.enabled) return;
    if (RECORD_STORES.includes(store)) enqueue("rec-del", store, key);
    else if (MEDIA_STORES.includes(store)) enqueue("media-del", store, key);
  };

  // Outbox items are keyed by target (store|id) so repeat writes coalesce to the
  // latest operation. Tiny — they hold no blobs, just a pointer to local data.
  function enqueue(op, store, id) {
    const key = store + "|" + id;
    dbPut("outbox", { id: key, op, store, target: id, ts: Date.now() })
      .then(() => scheduleFlush())
      .catch(() => {});
  }

  /* ---------- flushing the outbox ---------- */
  let flushTimer = null, flushing = false;
  function scheduleFlush(delay = 400) {
    if (!Sync.enabled) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay);
  }

  async function flush() {
    if (!Sync.enabled || flushing) return;
    if (!navigator.onLine) { setStatus("offline"); return; }
    flushing = true;
    setStatus("syncing");
    try {
      const items = (await dbAll("outbox")).sort((a, b) => a.ts - b.ts);
      for (const it of items) {
        try {
          await runOp(it);
          await dbDel("outbox", it.id);
        } catch (e) {
          // leave it in the outbox to retry next time
          console.warn("[sync] op failed, will retry:", it.op, it.store, it.target, e);
          throw e;
        }
      }
      setStatus(navigator.onLine ? "synced" : "offline");
    } catch (_) {
      setStatus(navigator.onLine ? "error" : "offline");
    } finally {
      flushing = false;
    }
  }

  async function runOp(it) {
    const c = Sync.client;
    if (it.op === "rec-put") {
      const rec = await dbGet(it.store, it.target);
      if (!rec) return; // deleted before flush; a rec-del will handle it
      const { error } = await c.from("records").upsert({
        store: it.store, id: it.target, data: rec, deleted: false,
      }, { onConflict: "store,id" });
      if (error) throw error;
    } else if (it.op === "rec-del") {
      const { error } = await c.from("records").upsert({
        store: it.store, id: it.target, data: { id: it.target, updatedAt: Date.now() }, deleted: true,
      }, { onConflict: "store,id" });
      if (error) throw error;
    } else if (it.op === "media-put") {
      const rec = await dbGet(it.store, it.target);
      if (!rec || !rec.blob) return;
      const path = it.store + "/" + it.target;
      const { error } = await c.storage.from(BUCKET).upload(path, rec.blob, {
        upsert: true, contentType: rec.blob.type || (it.store === "photos" ? "image/jpeg" : "audio/webm"),
      });
      if (error && !/exists/i.test(error.message || "")) throw error;
    } else if (it.op === "media-del") {
      const path = it.store + "/" + it.target;
      const { error } = await c.storage.from(BUCKET).remove([path]);
      if (error) throw error;
    }
  }

  /* ---------- pulling remote changes ---------- */
  async function pull() {
    if (!Sync.enabled || !navigator.onLine) return;
    const cursor = (await metaGet("cursor")) || EPOCH;
    const { data, error } = await Sync.client
      .from("records").select("*").gt("updated_at", cursor).order("updated_at", { ascending: true });
    if (error) { setStatus("error"); return; }
    if (!data || !data.length) return;
    let changed = false, maxCursor = cursor;
    for (const row of data) {
      if (await applyRow(row)) changed = true;
      if (row.updated_at > maxCursor) maxCursor = row.updated_at;
    }
    await metaSet("cursor", maxCursor);
    if (changed && typeof window.reloadGarden === "function") window.reloadGarden();
  }

  // Apply one remote row to the local DB. Returns true if local data changed.
  async function applyRow(row) {
    const { store, id, data, deleted } = row;
    if (!RECORD_STORES.includes(store)) return false;
    Sync._suspend = true;
    try {
      if (deleted) {
        const existed = !!(await dbGet(store, id));
        if (existed) { await dbDel(store, id); return true; }
        return false;
      }
      const local = await dbGet(store, id);
      const remoteT = (data && data.updatedAt) || 0;
      const localT = (local && local.updatedAt) || 0;
      if (!local || remoteT >= localT) {
        await dbPut(store, data);
        return true;
      }
      return false;
    } finally {
      Sync._suspend = false;
    }
  }

  /* ---------- media fetch-on-demand (called from blobURL) ---------- */
  const inflight = new Map();
  Sync.fetchMedia = function (store, id) {
    if (!Sync.enabled || !navigator.onLine) return Promise.resolve(null);
    if (!MEDIA_STORES.includes(store)) return Promise.resolve(null);
    const key = store + ":" + id;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const { data, error } = await Sync.client.storage.from(BUCKET).download(store + "/" + id);
        if (error || !data) return null;
        Sync._suspend = true;
        try { await dbPut(store, { id, blob: data }); } finally { Sync._suspend = false; }
        return data;
      } catch (_) { return null; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  };

  /* ---------- realtime ---------- */
  function subscribe() {
    try {
      Sync.client
        .channel("records-stream")
        .on("postgres_changes", { event: "*", schema: "public", table: "records" }, async (payload) => {
          const row = payload.new && payload.new.store ? payload.new : payload.old;
          if (!row) return;
          const changed = await applyRow(row);
          if (row.updated_at) {
            const cur = (await metaGet("cursor")) || EPOCH;
            if (row.updated_at > cur) await metaSet("cursor", row.updated_at);
          }
          if (changed && typeof window.reloadGarden === "function") window.reloadGarden();
        })
        .subscribe();
    } catch (e) { console.warn("[sync] realtime unavailable:", e); }
  }

  /* ---------- first-run migration: push everything already on this device ---- */
  async function seedFromLocal() {
    if (await metaGet("seeded")) return;
    for (const store of RECORD_STORES) {
      const rows = await dbAll(store).catch(() => []);
      for (const r of rows) enqueue("rec-put", store, store === "kv" ? r.k : r.id);
    }
    for (const store of MEDIA_STORES) {
      const rows = await dbAll(store).catch(() => []);
      for (const r of rows) enqueue("media-put", store, r.id);
    }
    await metaSet("seeded", true);
  }

  /* ---------- backup export (belt-and-suspenders, works offline) ---------- */
  Sync.exportBackup = async function () {
    const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
    const out = { app: "the-garden", version: 1, exportedAt: new Date().toISOString(), records: {}, media: [] };
    for (const store of RECORD_STORES) out.records[store] = await dbAll(store).catch(() => []);
    for (const store of MEDIA_STORES) {
      for (const r of (await dbAll(store).catch(() => []))) {
        if (r.blob) out.media.push({ store, id: r.id, dataUrl: await blobToDataURL(r.blob) });
      }
    }
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "garden-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  /* ---------- lifecycle ---------- */
  Sync.start = async function () {
    if (!Sync.enabled) { setStatus("off"); return; }
    setStatus(navigator.onLine ? "syncing" : "offline");
    await seedFromLocal();
    await flush();
    await pull();
    subscribe();
    setStatus(navigator.onLine ? "synced" : "offline");

    window.addEventListener("online", () => { setStatus("syncing"); flush().then(pull); });
    window.addEventListener("offline", () => setStatus("offline"));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { flush().then(pull); } });
    setInterval(() => { if (navigator.onLine) flush().then(pull); }, 30000);
  };
})();
