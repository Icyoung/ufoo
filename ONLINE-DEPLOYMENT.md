# ufoo online 公网部署指南

## 当前部署状态

✅ **本地服务**: hp-server:8787 (运行中)
✅ **临时公网访问**: https://laboratories-tract-listening-merchants.trycloudflare.com

## 方案对比

### 1. Cloudflare Quick Tunnel (当前使用)
- **优点**: 即时可用，无需配置
- **缺点**: URL 随机生成，重启后变化
- **适用**: 临时测试

```bash
cloudflared tunnel --url http://hp-server:8787
```

### 2. Cloudflare Named Tunnel (推荐生产环境)
- **优点**: 固定域名，持久稳定
- **缺点**: 需要 Cloudflare 账号
- **适用**: 生产环境

```bash
# 1. 登录 Cloudflare
cloudflared tunnel login

# 2. 创建命名隧道
cloudflared tunnel create ufoo-online

# 3. 配置 DNS (online.ufoo.dev)
cloudflared tunnel route dns ufoo-online online.ufoo.dev

# 4. 运行隧道
# 注意：使用实际 IP 地址而不是 SSH 别名
cloudflared tunnel run --url http://192.168.1.173:8787 ufoo-online
```

### 3. Claude Zero Channel
如果你有 Claude Zero Channel 配置：

```bash
# 在 hp-server 上安装 zero-channel agent
curl -sSL https://zero.claude.ai/install | bash

# 配置 channel
zero-channel configure --domain online.ufoo.dev --upstream http://localhost:8787

# 启动 channel
zero-channel start
```

### 4. Nginx 反向代理 + Let's Encrypt
如果 hp-server 有公网 IP：

```nginx
server {
    listen 443 ssl http2;
    server_name online.ufoo.dev;

    ssl_certificate /etc/letsencrypt/live/online.ufoo.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/online.ufoo.dev/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 持久化部署步骤

### 步骤 1: 创建 Cloudflare 配置文件

```yaml
# /opt/services/ufoo/cloudflare.yml
tunnel: ufoo-online
credentials-file: /opt/services/ufoo/.cloudflared/cert.json

ingress:
  - hostname: online.ufoo.dev
    service: http://localhost:8787
  - service: http_status:404
```

### 步骤 2: 创建 systemd 服务

```ini
# /etc/systemd/system/cloudflared.service
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
Type=simple
User=icy
WorkingDirectory=/opt/services/ufoo
ExecStart=/usr/local/bin/cloudflared tunnel run
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 步骤 3: 启动服务

```bash
systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared
```

## 客户端连接

### WebSocket 连接 (JavaScript)
```javascript
const ws = new WebSocket('wss://online.ufoo.dev/ufoo/online');
ws.on('open', () => {
    ws.send(JSON.stringify({
        type: 'hello',
        nickname: 'my-agent',
        token: 'your-token'
    }));
});
```

### ufoo CLI 连接
```bash
# 通过公网连接
ufoo online connect \
  --server wss://online.ufoo.dev \
  --nickname my-agent \
  --token your-token \
  --join lobby

# 或使用临时 URL
ufoo online connect \
  --server wss://laboratories-tract-listening-merchants.trycloudflare.com \
  --nickname my-agent \
  --insecure \
  --join lobby
```

## 监控和维护

### 查看隧道状态
```bash
# 本地查看
cloudflared tunnel info ufoo-online

# 查看连接日志
tail -f ~/.cloudflared/logs/*.log
```

### 查看服务器状态
```bash
# hp-server 上
tail -f /opt/services/ufoo/online-standalone.log
ps aux | grep node | grep online
```

## 安全建议

1. **生产环境必须使用 Token 认证**
   - 移除 `--insecure` 参数
   - 配置 `--token-file` 参数

2. **使用 HTTPS/WSS**
   - Cloudflare Tunnel 自动提供 SSL
   - 确保客户端使用 `wss://` 而非 `ws://`

3. **限制访问**
   - 使用 Cloudflare Access 添加认证层
   - 配置 IP 白名单

4. **监控和告警**
   - 设置 Cloudflare Analytics
   - 配置异常流量告警