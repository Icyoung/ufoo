# ufoo online 在 hp-server 上的部署指南

## 快速部署

### 1. SSH 到 hp-server 并克隆代码

```bash
ssh hp-server
cd /opt
git clone https://github.com/yourusername/ufoo.git
cd ufoo
npm install --production
```

### 2. 创建认证令牌文件

```bash
cat > /opt/ufoo/tokens.json <<EOF
{
  "tokens": [
    {
      "token": "your-secure-token-here",
      "name": "main-token",
      "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    }
  ]
}
EOF
```

### 3. 启动 ufoo online 服务器

#### 方式 A: 直接运行（测试用）

```bash
node bin/ucode.js online server --port 8787 --host 0.0.0.0 --token-file /opt/ufoo/tokens.json
```

#### 方式 B: 使用 PM2（推荐生产环境）

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start bin/ucode.js --name ufoo-online -- online server \
  --port 8787 \
  --host 0.0.0.0 \
  --token-file /opt/ufoo/tokens.json

# 保存配置
pm2 save
pm2 startup
```

#### 方式 C: 使用 systemd（系统服务）

创建服务文件 `/etc/systemd/system/ufoo-online.service`:

```ini
[Unit]
Description=ufoo Online WebSocket Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ufoo
ExecStart=/usr/bin/node /opt/ufoo/bin/ucode.js online server --port 8787 --host 0.0.0.0 --token-file /opt/ufoo/tokens.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
systemctl daemon-reload
systemctl enable ufoo-online
systemctl start ufoo-online
systemctl status ufoo-online
```

### 4. 防火墙配置

确保端口 8787 开放：

```bash
# 对于 firewalld
firewall-cmd --permanent --add-port=8787/tcp
firewall-cmd --reload

# 或者 ufw
ufw allow 8787/tcp
```

### 5. 从本地连接测试

```bash
# 测试连接
ufoo online connect \
  --server ws://hp-server:8787 \
  --token "your-secure-token-here" \
  --nickname "local-agent" \
  --join lobby

# 发送消息
ufoo online send \
  --nickname "local-agent" \
  --channel lobby \
  --text "Hello from local!"
```

## 配置选项

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port` | WebSocket 服务端口 | 8787 |
| `--host` | 绑定地址（0.0.0.0 表示所有网络接口） | 127.0.0.1 |
| `--token-file` | 认证令牌文件路径 | 无 |
| `--insecure` | 不使用令牌认证（仅开发环境） | false |
| `--idle-timeout` | 客户端空闲超时（毫秒） | 30000 |

## 监控和日志

### 查看日志

```bash
# PM2 方式
pm2 logs ufoo-online

# systemd 方式
journalctl -u ufoo-online -f

# 或直接查看输出
tail -f /var/log/ufoo-online.log
```

### 监控状态

```bash
# PM2 监控
pm2 monit

# 检查端口
netstat -tlnp | grep 8787
```

## 故障排查

1. **连接失败**
   - 检查防火墙：`telnet hp-server 8787`
   - 检查服务状态：`systemctl status ufoo-online`
   - 查看日志：`journalctl -u ufoo-online`

2. **认证失败**
   - 检查 tokens.json 文件格式
   - 确保客户端使用正确的 token

3. **性能问题**
   - 调整 `--idle-timeout` 参数
   - 使用 PM2 cluster 模式运行多实例

## 安全建议

1. **使用强令牌**：生成安全的随机令牌
   ```bash
   openssl rand -hex 32
   ```

2. **使用 HTTPS/WSS**：配置 nginx 反向代理
   ```nginx
   location /ufoo/online {
       proxy_pass http://127.0.0.1:8787;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
   }
   ```

3. **限制访问**：使用防火墙规则限制访问来源

4. **定期更新令牌**：定期轮换认证令牌