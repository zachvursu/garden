> **ARCHIVED — do not edit or deploy from here.**
> The garden app now lives in `public/garden/` of the `zachvursu/zachlinder.com`
> repo and is served at zachlinder.com/garden. Changes made in this repo never
> reach production. Make all changes there.

# The Garden — a private, installable garden PWA

A voice + written diary for your plot. Everything (entries, photos, voice memos,
plant care pages, the plot map) is stored **on your device** in the browser —
it works offline and nothing is uploaded anywhere.

## What's inside
- `index.html` — the whole app (UI + logic)
- `manifest.webmanifest` — makes it installable
- `sw.js` — service worker for offline use
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` — app icons

## How to put it online (pick one)
A PWA must be served over **HTTPS** to install and work offline. Any of these:

- **Netlify Drop** — go to app.netlify.com/drop and drag this whole folder in. Done.
- **Vercel** — `vercel` in this folder, or drag-drop in the dashboard. (You already use Vercel.)
- **GitHub Pages** — push these files to a repo, enable Pages on the branch.
- **Cloudflare Pages** — connect the repo or upload the folder.

Then open the URL on your phone.

## Install to your home screen
- **iPhone (Safari):** open the URL → Share → **Add to Home Screen**.
- **Android/desktop (Chrome/Edge):** you'll get an **Install** prompt, or use the browser menu → Install.

Once installed it opens full-screen like a native app and runs offline.

## Voice notes
- Tap the **mic** in a new entry to dictate — your words fill the note. (Works in
  Chrome and most Android/desktop browsers.)
- On **iPhone**, live dictation may be unavailable in-app; just tap the note field
  and use the **keyboard's microphone** — same result, zero friction.
- **Voice memo** records and keeps the raw audio clip attached to the entry.

## Good to know
- Data lives in this browser's storage. Keep the app installed; **clearing site
  data / "Clear browsing data" will erase entries.** (Ask me for an export/import
  backup feature — it's an easy add.)
- The AI "idea helper" from the earlier in-Claude version isn't wired up here,
  because a hosted PWA would need an API key/server to call it. Ask me and I'll
  add it with a small serverless function.
