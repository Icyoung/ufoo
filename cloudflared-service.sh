#!/bin/bash

# 创建 systemd 服务文件来后台运行 cloudflared

cat <<EOF | sudo tee /etc/systemd/system/cloudflared-ufoo.service
[Unit]
Description=Cloudflare Tunnel for ufoo-online
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/local/bin/cloudflared tunnel run --url http://localhost:8787 ufoo-online
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "Service file created. To start the service:"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable cloudflared-ufoo"
echo "  sudo systemctl start cloudflared-ufoo"
echo ""
echo "To check status:"
echo "  sudo systemctl status cloudflared-ufoo"
echo "  sudo journalctl -u cloudflared-ufoo -f"