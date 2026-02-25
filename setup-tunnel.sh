#!/bin/bash

# Setup Cloudflare Tunnel for online.ufoo.dev

echo "Setting up Cloudflare Tunnel for online.ufoo.dev..."

# Option 1: Quick tunnel (temporary, no authentication needed)
echo "Starting quick tunnel to hp-server:8787..."
cloudflared tunnel --url http://hp-server:8787

# Option 2: Named tunnel (permanent, requires Cloudflare account)
# Uncomment below if you have cloudflare account configured
# cloudflared tunnel login
# cloudflared tunnel create ufoo-online
# cloudflared tunnel route dns ufoo-online online.ufoo.dev
# cloudflared tunnel run --url http://hp-server:8787 ufoo-online