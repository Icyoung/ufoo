#!/bin/bash
# Auto deploy ufoo online to hp-server

set -e

REMOTE_HOST="hp-server"
REMOTE_USER="icy"
REMOTE_PASS="510510"
REMOTE_DIR="/home/icy/ufoo"

echo "Starting deployment to hp-server..."

# Step 1: Create directory on remote
echo "Step 1: Creating directory on hp-server..."
sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST "mkdir -p $REMOTE_DIR"

# Step 2: Copy files (excluding node_modules and .git)
echo "Step 2: Copying ufoo files to hp-server..."
tar czf - --exclude=node_modules --exclude=.git --exclude=.ufoo . | \
  sshpass -p "$REMOTE_PASS" ssh $REMOTE_USER@$REMOTE_HOST "cd $REMOTE_DIR && tar xzf -"

# Step 3: Install Node.js if needed
echo "Step 3: Checking Node.js installation..."
sshpass -p "$REMOTE_PASS" ssh $REMOTE_USER@$REMOTE_HOST "which node || (curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - && yum install -y nodejs)"

# Step 4: Install dependencies
echo "Step 4: Installing dependencies..."
sshpass -p "$REMOTE_PASS" ssh $REMOTE_USER@$REMOTE_HOST "cd $REMOTE_DIR && npm install --production"

# Step 5: Create token file
echo "Step 5: Creating token file..."
TOKEN=$(openssl rand -hex 32)
sshpass -p "$REMOTE_PASS" ssh $REMOTE_USER@$REMOTE_HOST "cat > $REMOTE_DIR/tokens.json" <<EOF
{
  "tokens": [
    {
      "token": "$TOKEN",
      "name": "main-token",
      "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    }
  ]
}
EOF

# Step 6: Start the service
echo "Step 6: Starting ufoo online service..."
sshpass -p "$REMOTE_PASS" ssh $REMOTE_USER@$REMOTE_HOST "cd $REMOTE_DIR && nohup node bin/ucode.js online server --port 8787 --host 0.0.0.0 --token-file $REMOTE_DIR/tokens.json > /var/log/ufoo-online.log 2>&1 &"

echo ""
echo "========================================"
echo "Deployment completed successfully!"
echo "========================================"
echo "Server: ws://hp-server:8787/ufoo/online"
echo "Token: $TOKEN"
echo ""
echo "Test connection with:"
echo "  node bin/ucode.js online connect --server ws://hp-server:8787 --token $TOKEN --nickname test-agent"
echo ""