#!/bin/bash

# 停止 Cloudflare Tunnel 的脚本

PID_FILE="/tmp/cloudflared-ufoo.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "PID file not found. Tunnel might not be running."
    echo "Checking for cloudflared processes..."

    # 查找所有 cloudflared 进程
    PIDS=$(pgrep -f "cloudflared tunnel run.*ufoo-online")

    if [ -z "$PIDS" ]; then
        echo "No cloudflared tunnel processes found."
    else
        echo "Found cloudflared processes: $PIDS"
        echo "Kill them manually: kill $PIDS"
    fi
    exit 1
fi

PID=$(cat "$PID_FILE")

if ps -p "$PID" > /dev/null 2>&1; then
    echo "Stopping Cloudflare tunnel (PID: $PID)..."
    kill "$PID"

    # 等待进程结束
    sleep 2

    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Process still running, forcing stop..."
        kill -9 "$PID"
    fi

    rm "$PID_FILE"
    echo "✅ Cloudflare tunnel stopped."
else
    echo "Process $PID is not running."
    rm "$PID_FILE"
fi