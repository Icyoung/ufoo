#!/bin/bash

# 后台运行 Cloudflare Tunnel 的脚本

# 配置
TUNNEL_NAME="ufoo-online"
UPSTREAM_URL="http://localhost:8787"
LOG_FILE="/tmp/cloudflared-ufoo.log"
PID_FILE="/tmp/cloudflared-ufoo.pid"

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "Cloudflare tunnel is already running (PID: $OLD_PID)"
        echo "To stop: kill $OLD_PID"
        exit 1
    else
        echo "Removing stale PID file"
        rm "$PID_FILE"
    fi
fi

# 启动隧道
echo "Starting Cloudflare tunnel in background..."
nohup cloudflared tunnel run --url "$UPSTREAM_URL" "$TUNNEL_NAME" > "$LOG_FILE" 2>&1 &
TUNNEL_PID=$!

# 保存 PID
echo $TUNNEL_PID > "$PID_FILE"

# 等待几秒确认启动
sleep 3

# 检查是否成功启动
if ps -p $TUNNEL_PID > /dev/null; then
    echo "✅ Cloudflare tunnel started successfully!"
    echo "   PID: $TUNNEL_PID"
    echo "   Log: $LOG_FILE"
    echo ""
    echo "Commands:"
    echo "   View logs:  tail -f $LOG_FILE"
    echo "   Check status: ps -p $TUNNEL_PID"
    echo "   Stop tunnel: kill $TUNNEL_PID"
    echo ""

    # 显示最后几行日志
    echo "Recent log entries:"
    tail -5 "$LOG_FILE"
else
    echo "❌ Failed to start Cloudflare tunnel"
    echo "Check logs at: $LOG_FILE"
    tail -20 "$LOG_FILE"
    exit 1
fi