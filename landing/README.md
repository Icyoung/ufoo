# UFOO Landing Page

Static marketing and product preview pages for `ufoo.dev`.

## Quick Start

```bash
cd landing
npm install
npm run dev
```

The site is static. `npm run dev` and `npm run preview` both serve the current directory with `npx serve .`; `npm run build` is a no-op that documents that no build step is required.

## Pages

- `index.html`: main landing page.
- `docs.html`: static docs page.
- `online.html`: ufoo online showcase page.
- `room.html`: private room preview page.

## Deploy To Vercel

Install and log in to the Vercel CLI if needed:

```bash
npm install -g vercel
vercel login
```

Deploy from `landing/`:

```bash
vercel --prod
```

## Custom Domain

In the Vercel dashboard, add `ufoo.dev` and `www.ufoo.dev` under Settings -> Domains, then configure DNS:

```text
# Root domain
Type: A
Name: @
Value: 76.76.21.21

# www
Type: CNAME
Name: www
Value: cname.vercel-dns.com
```

## Project Structure

```text
landing/
  index.html       main landing page
  docs.html        documentation page
  online.html      ufoo online showcase
  room.html        room preview
  style.css        main landing styles
  docs.css         docs styles
  online.css       online preview styles
  online.js        online API/WebSocket binding
  room.js          room preview behavior
  i18n.js          landing page copy/localization helpers
  package.json     npm scripts
  vercel.json      Vercel routing/config
  README.md        this file
```

## Design Notes

- Font direction: terminal-oriented monospace.
- Main palette: near-black background, cyan ufoo accent, green success, orange Claude accent, purple bus/context accent.
- The landing directory does not contain deploy or publish helper scripts; use the root package release flow documented in `../README.md` for npm publishing.
