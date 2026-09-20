# Hush

Your own ad-free music player on Cloudflare. You upload songs you own or have
the rights to; Hush streams them on phone and desktop. No Audius, no third-party catalog.

## What you get
- **Player** (`/`): home, genres, artists, search, liked songs, queue, shuffle/repeat,
  lock-screen controls, mobile layout with mini player.
- **Admin** (`/admin/`): password-protected page to upload (many files at once),
  set artist / genre / cover art, edit and delete songs.
- **Storage**: audio and covers live in a Cloudflare R2 bucket (free tier: 10 GB,
  and no fees for streaming out).

## Set up (one time)
```bash
npm install
npx wrangler login
npx wrangler r2 bucket create hush-music     # you may need to enable R2 in the Cloudflare dashboard first
npx wrangler secret put ADMIN_PASSWORD       # pick a long password
npm run deploy
```
Deploy prints your URL (`https://hush-music.<your-subdomain>.workers.dev`).
Open `/admin/`, sign in, and upload.

## Try it locally first
```bash
echo "ADMIN_PASSWORD=change-me" > .dev.vars
npm run dev                                  # http://localhost:8787  (uses a local fake R2, nothing is uploaded to Cloudflare)
```

## Good to know
- Upload limit is 95 MB per file (Cloudflare's request limit on Free/Pro is 100 MB). MP3 or M4A keep files small.
- The site is public: anyone with the link can listen, but only you can upload.
  To make listening private too, put the whole site behind Cloudflare Access
  (Zero Trust dashboard -> Access -> Applications).
- Liked songs and recently played are stored in each visitor's browser.
- The library is one `index.json` in the bucket. Uploads from one admin are safe;
  don't upload from two devices at the same moment.
- Only upload music you made or have permission to share.

## Files
- `public/index.html` player (single file)
- `public/admin/index.html` admin page (single file)
- `src/worker.js` API, auth and streaming (with Range support for seeking)
- `wrangler.jsonc` config (R2 binding `MUSIC`)
