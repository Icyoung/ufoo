#!/bin/bash
# ufoo online deployment script for hp-server

set -e

# Configuration
REMOTE_HOST="hp-server"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_DIR="/opt/ufoo"
ONLINE_PORT="${ONLINE_PORT:-8787}"
TOKEN_FILE="${TOKEN_FILE:-/opt/ufoo/tokens.json}"

echo "Deploying ufoo online to $REMOTE_HOST..."

# Step 1: Copy ufoo to server
echo "Step 1: Syncing ufoo codebase to $REMOTE_HOST..."
ssh $REMOTE_USER@$REMOTE_HOST "mkdir -p $REMOTE_DIR"
rsync -av --exclude node_modules --exclude .git \
  $(pwd)/ $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/

# Step 2: Install dependencies on server
echo "Step 2: Installing dependencies..."
ssh $REMOTE_USER@$REMOTE_HOST "cd $REMOTE_DIR && npm install --production"

# Step 3: Create systemd service
echo "Step 3: Creating systemd service..."
cat <<EOF | ssh $REMOTE_USER@$REMOTE_HOST "cat > /etc/systemd/system/ufoo-online.service"
[Unit]
Description=ufoo Online WebSocket Relay Server
After=network.target

[Service]
Type=simple
User=$REMOTE_USER
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node $REMOTE_DIR/bin/ucode.js online server --port $ONLINE_PORT --token-file $TOKEN_FILE --host 0.0.0.0
Restart=always
RestartSec=10
StandardOutput=append:/var/log/ufoo-online.log
StandardError=append:/var/log/ufoo-online.log

[Install]
WantedBy=multi-user.target
EOF

# Step 4: Create tokens file
echo "Step 4: Setting up authentication tokens..."
cat <<EOF | ssh $REMOTE_USER@$REMOTE_HOST "cat > $TOKEN_FILE"
{
  "tokens": [
    {
      "token": "$(openssl rand -hex 32)",
      "name": "main-token",
      "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    }
  ]
}
EOF

# Step 5: Start service
echo "Step 5: Starting ufoo-online service..."
ssh $REMOTE_USER@$REMOTE_HOST "systemctl daemon-reload && systemctl enable ufoo-online && systemctl restart ufoo-online"

# Step 6: Check status
echo "Step 6: Checking service status..."
ssh $REMOTE_USER@$REMOTE_HOST "systemctl status ufoo-online --no-pager"

# Step 7: Show connection info
echo ""
echo "========================================"
echo "ufoo online deployed successfully!"
echo "========================================"
echo "Server: ws://$REMOTE_HOST:$ONLINE_PORT/ufoo/online"
echo "Token file: $TOKEN_FILE"
echo ""
echo "To connect from local machine:"
echo "  ufoo online connect --server ws://$REMOTE_HOST:$ONLINE_PORT --token <token>"
echo ""
echo "To check logs:"
echo "  ssh $REMOTE_USER@$REMOTE_HOST 'tail -f /var/log/ufoo-online.log'"
echo ""