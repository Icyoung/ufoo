# UFOO Landing Page

> Just Add u. That's It.

## Quick Start

```bash
# Preview locally
npx serve .

# Or with npm
npm run dev
```

## Deploy to Vercel

### First Time Setup

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Login to Vercel:
```bash
vercel login
```

3. Deploy:
```bash
./scripts/deploy.sh
# or manually:
vercel --prod
```

### Configure Custom Domain (ufoo.dev)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project → Settings → Domains
3. Add `ufoo.dev` and `www.ufoo.dev`
4. Configure DNS at your domain registrar:

```
# For root domain (ufoo.dev)
Type: A
Name: @
Value: 76.76.21.21

# For www subdomain
Type: CNAME
Name: www
Value: cname.vercel-dns.com
```

## Project Structure

```
landing/
├── index.html      # Main landing page
├── online.html     # ufoo online showcase page
├── style.css       # Styles (Terminal/Hacker aesthetic)
├── online.css      # Styles (ufoo online preview)
├── online.js       # Real online API + WebSocket binding
├── package.json    # Package config
├── vercel.json     # Vercel deployment config
├── scripts/
│   ├── deploy.sh       # Vercel deploy script
│   └── publish-npm.sh  # npm publish helper
└── README.md       # This file
```

## Design System

- **Font**: JetBrains Mono (monospace)
- **Colors**:
  - Background: `#0C0C0C` (near black)
  - Card: `#1A1A1A`
  - Cyan (u prefix): `#22D3EE`
  - Green (success): `#22C55E`
  - Orange (claude): `#F97316`
  - Purple (bus/ctx): `#A78BFA`

## npm Package Publishing

To publish the main ufoo package to npm:

```bash
cd /path/to/ufoo-package
../landing/scripts/publish-npm.sh
```

Or manually:

```bash
npm login
npm publish --access public
```
