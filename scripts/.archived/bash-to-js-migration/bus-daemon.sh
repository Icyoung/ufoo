#!/usr/bin/env bash
set -euo pipefail

# bus-daemon.sh
# Daemon that watches for new messages and injects /bus into target terminals.
#
# Usage:
#   bash scripts/bus-daemon.sh [--interval <seconds>] [--daemon]
#
# This script monitors ALL subscribers' pending queues and injects /bus
# into their corresponding Terminal.app tabs when new messages arrive.
#
# Requirements:
# - macOS Accessibility permission for Terminal.app
# - Each subscriber's terminal should have title containing [bus:<instance-id>]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUS_DIR=".ufoo/bus"
INTERVAL=2
DAEMON_MODE=0
PID_FILE="$BUS_DIR/.daemon.pid"
LOG_FILE="$BUS_DIR/logs/daemon.log"

usage() {
  cat <<'USAGE'
bus-daemon.sh - Watch for new messages and inject /bus

Usage:
  bash scripts/bus-daemon.sh [options]

Options:
  --interval <n>   Poll interval in seconds (default: 2)
  --daemon         Run in background
  --stop           Stop running daemon
  --status         Check daemon status
  -h, --help       Show this help

Notes:
  - Requires macOS Accessibility permission
  - Terminals must have title containing [bus:<instance-id>]
  - Use `ufoo bus join` to set terminal title
USAGE
}

# Handle --help before other parsing
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --daemon)
      DAEMON_MODE=1
      shift
      ;;
    --stop)
      if [[ -f "$PID_FILE" ]]; then
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [[ -n "$pid" ]]; then
          kill "$pid" 2>/dev/null && echo "[daemon] Stopped (pid=$pid)" || echo "[daemon] Not running"
        fi
        rm -f "$PID_FILE"
      else
        echo "[daemon] Not running"
      fi
      exit 0
      ;;
    --status)
      if [[ -f "$PID_FILE" ]]; then
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
          echo "[daemon] Running (pid=$pid)"
        else
          echo "[daemon] Not running (stale pid file)"
          rm -f "$PID_FILE"
        fi
      else
        echo "[daemon] Not running"
      fi
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$BUS_DIR" ]]; then
  echo "[daemon] Error: $BUS_DIR not found. Run ufoo init first." >&2
  exit 1
fi

mkdir -p "$BUS_DIR/logs"

if [[ "$DAEMON_MODE" == "1" ]]; then
  # Check if already running
  if [[ -f "$PID_FILE" ]]; then
    existing="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
      echo "[daemon] Already running (pid=$existing)"
      exit 0
    fi
  fi

  echo "[daemon] Starting in background (log: $LOG_FILE)"
  nohup bash "$0" --interval "$INTERVAL" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "[daemon] Started (pid=$!)"
  exit 0
fi

# Record PID
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE" 2>/dev/null || true; rm -rf "$COUNTS_DIR" 2>/dev/null || true' EXIT

echo "[daemon] Started (pid=$$, interval=${INTERVAL}s)"
echo "[daemon] Watching: $BUS_DIR/queues/*/pending.jsonl"

# Use temp directory to track last known counts (bash 3.x compatible)
COUNTS_DIR="$BUS_DIR/.daemon-counts.$$"
mkdir -p "$COUNTS_DIR"

get_last_count() {
  local safe_name="$1"
  local count_file="$COUNTS_DIR/$safe_name"
  if [[ -f "$count_file" ]]; then
    cat "$count_file"
  else
    echo "0"
  fi
}

set_last_count() {
  local safe_name="$1"
  local count="$2"
  echo "$count" > "$COUNTS_DIR/$safe_name"
}

# Cleanup dead agents (check PID and mark offline)
cleanup_dead_agents() {
  if [[ ! -f "$BUS_DIR/bus.json" ]]; then
    return
  fi

  local changed=0
  local tmp_file
  tmp_file=$(mktemp)

  # Get all active subscribers with their PIDs
  while IFS='|' read -r subscriber pid; do
    [[ -z "$subscriber" || -z "$pid" ]] && continue

    # Check if PID is still running AND is a claude/codex/node process
    local proc_cmd
    proc_cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    if [[ -z "$proc_cmd" ]] || ! echo "$proc_cmd" | grep -qiE "(claude|codex|node)"; then
      echo "[daemon] $(date '+%H:%M:%S') Agent $subscriber (pid=$pid) is dead, marking offline"

      # Mark as offline in bus.json
      jq --arg name "$subscriber" \
         '.subscribers[$name].status = "offline"' \
         "$BUS_DIR/bus.json" > "$tmp_file" && mv "$tmp_file" "$BUS_DIR/bus.json"
      tmp_file=$(mktemp)

      # Clean up queue directory
      local safe_name="${subscriber//:/_}"
      rm -rf "$BUS_DIR/queues/${safe_name}" 2>/dev/null || true
      rm -f "$BUS_DIR/offsets/${safe_name}.offset" 2>/dev/null || true

      changed=1
    fi
  done < <(jq -r '.subscribers | to_entries[] | select(.value.status == "active") | "\(.key)|\(.value.pid)"' "$BUS_DIR/bus.json" 2>/dev/null)

  rm -f "$tmp_file" 2>/dev/null || true
}

CLEANUP_COUNTER=0
CLEANUP_INTERVAL=5  # Run cleanup every 5 cycles (10 seconds with default interval)

while true; do
  # Periodic cleanup of dead agents
  ((CLEANUP_COUNTER++)) || true
  if [[ $CLEANUP_COUNTER -ge $CLEANUP_INTERVAL ]]; then
    cleanup_dead_agents
    CLEANUP_COUNTER=0
  fi
  # Find all subscriber queue files
  for queue_file in "$BUS_DIR/queues"/*/pending.jsonl; do
    if [[ ! -f "$queue_file" ]]; then
      continue
    fi

    # Extract subscriber from path: .ufoo/bus/queues/claude-code_abc123/pending.jsonl
    dir_name="$(basename "$(dirname "$queue_file")")"
    # Convert back to subscriber format: claude-code_abc123 -> claude-code:abc123
    subscriber="${dir_name/_/:}"

    # Get current count
    if [[ -s "$queue_file" ]]; then
      count="$(wc -l < "$queue_file" | tr -d ' ')"
    else
      count=0
    fi

    # Get last known count
    last="$(get_last_count "$dir_name")"

    # If count increased, inject /bus
    if [[ "$count" -gt "$last" ]]; then
      echo "[daemon] $(date '+%H:%M:%S') New message for $subscriber ($last -> $count)"

      # Try to inject
      if bash "$SCRIPT_DIR/bus-inject.sh" "$subscriber" 2>&1; then
        echo "[daemon] Injected /bus into $subscriber"
      else
        echo "[daemon] Failed to inject (window not found or no permission)"
      fi
    fi

    set_last_count "$dir_name" "$count"
  done

  sleep "$INTERVAL"
done
