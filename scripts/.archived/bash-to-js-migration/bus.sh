#!/usr/bin/env bash
set -euo pipefail

# bus: Project-level Agent event bus
# Independent module, stored in .ufoo/bus/
#
# Usage: bus <command> [options]
#
# Commands:
#   init                    Initialize event bus
#   join [session-id]       Join bus (register current instance)
#   send <target> <message> Send targeted message
#   broadcast <message>     Broadcast message
#   check                   Check pending events
#   status                  View bus status
#   consume                 Consume events
#   leave                   Leave bus

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUS_DIR=".ufoo/bus"
DATE_FORMAT="%Y-%m-%dT%H:%M:%S.000Z"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[bus]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[bus]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[bus]${NC} $*"; }
log_error() { echo -e "${RED}[bus]${NC} $*" >&2; }

# ============================================================================
# Utility functions
# ============================================================================

get_timestamp() {
  date -u +"$DATE_FORMAT"
}

get_date() {
  date -u +"%Y-%m-%d"
}

generate_instance_id() {
  echo "$(date +%s%N | shasum | head -c 8)"
}

ensure_bus() {
  if [[ ! -d "$BUS_DIR" ]]; then
    log_error "Event bus not initialized. Please run: bus init or /uinit"
    exit 1
  fi
}

subscriber_to_safe_name() {
  echo "${1//:/_}"
}

get_next_seq() {
  local today_file="$BUS_DIR/events/$(get_date).jsonl"
  if [[ -f "$today_file" ]]; then
    local last_seq
    last_seq=$(tail -1 "$today_file" 2>/dev/null | jq -r '.seq // 0' 2>/dev/null || echo "0")
    echo $((last_seq + 1))
  else
    local max_seq=0
    shopt -s nullglob
    for f in "$BUS_DIR/events"/*.jsonl; do
      if [[ -f "$f" ]]; then
        local file_max
        file_max=$(tail -1 "$f" 2>/dev/null | jq -r '.seq // 0' 2>/dev/null || echo "0")
        if [[ $file_max -gt $max_seq ]]; then
          max_seq=$file_max
        fi
      fi
    done
    echo $((max_seq + 1))
  fi
}

# Best-effort check for currently running process.
is_pid_alive() {
  local pid="${1:-0}"
  if [[ -z "$pid" || "$pid" == "0" ]]; then
    return 1
  fi
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Resolve nickname to subscriber ID
resolve_nickname() {
  local nickname="$1"
  ensure_bus
  jq -r --arg nick "$nickname" \
    '.subscribers | to_entries[] | select(.value.nickname == $nick) | .key' \
    "$BUS_DIR/bus.json" | head -1
}

# Check if target matches subscriber
target_matches() {
  local target="$1"
  local subscriber="$2"

  # Priority 1: Wildcard/empty
  [[ -z "$target" || "$target" == "*" ]] && return 0

  # Priority 2: Exact subscriber ID match
  [[ "$target" == "$subscriber" ]] && return 0

  # Priority 3: Nickname match (resolve nickname to real ID)
  if [[ ! "$target" =~ : ]]; then
    local resolved
    resolved=$(resolve_nickname "$target")
    if [[ -n "$resolved" ]]; then
      [[ "$resolved" == "$subscriber" ]] && return 0
    fi
  fi

  # Priority 4: Agent type match
  local target_type="${target%%:*}"
  local target_instance="${target#*:}"
  local sub_type="${subscriber%%:*}"

  [[ "$target" == "$target_type" && "$target_type" == "$sub_type" ]] && return 0
  [[ "$target_instance" == "*" && "$target_type" == "$sub_type" ]] && return 0

  return 1
}

# ============================================================================
# Command: init
# ============================================================================

cmd_init() {
  if [[ -d "$BUS_DIR" ]]; then
    log_warn "Event bus already exists"
    return 0
  fi

  log_info "Initializing event bus..."

  mkdir -p "$BUS_DIR"/{events,offsets,queues}

  local project_name
  project_name=$(basename "$(pwd)")

  cat > "$BUS_DIR/bus.json" << EOF
{
  "bus_id": "${project_name}-bus",
  "created_at": "$(get_timestamp)",
  "subscribers": {},
  "agent_types": {},
  "config": {
    "poll_interval_ms": 3000,
    "heartbeat_timeout_ms": 30000
  }
}
EOF

  # Record initialization event
  local today_file="$BUS_DIR/events/$(get_date).jsonl"
  echo "{\"seq\":1,\"ts\":\"$(get_timestamp)\",\"type\":\"system\",\"event\":\"bus_created\",\"publisher\":\"system\",\"data\":{}}" >> "$today_file"

  log_ok "Event bus initialized: $BUS_DIR"
}

# ============================================================================
# Command: join (join bus)
# ============================================================================

cmd_join() {
  local session_id="${1:-}"
  local agent_type="${2:-}"
  local nickname="${3:-}"

  ensure_bus

  # If no session_id provided, try to get from env or generate
  if [[ -z "$session_id" ]]; then
    session_id="${CLAUDE_SESSION_ID:-${CODEX_SESSION_ID:-$(generate_instance_id)}}"
  fi

  # If no agent_type provided, auto-detect from env
  if [[ -z "$agent_type" ]]; then
    if [[ -n "${CODEX_SESSION_ID:-}" ]]; then
      agent_type="codex"
    else
      agent_type="claude-code"
    fi
  fi

  local subscriber="${agent_type}:${session_id}"
  local safe_name
  safe_name=$(subscriber_to_safe_name "$subscriber")

  # Check if subscriber already exists (rejoin scenario)
  local existing_nickname
  existing_nickname=$(jq -r --arg id "$subscriber" '.subscribers[$id].nickname // ""' "$BUS_DIR/bus.json" 2>/dev/null)

  # Handle nickname: reuse existing, auto-generate, or use provided
  if [[ -n "$existing_nickname" ]]; then
    # Subscriber already exists
    if [[ -z "$nickname" ]]; then
      # No nickname provided: reuse existing
      nickname="$existing_nickname"
    elif [[ "$nickname" != "$existing_nickname" ]]; then
      # Different nickname provided: error (use cmd_rename instead)
      log_error "Subscriber $subscriber already exists with nickname '$existing_nickname'"
      log_error "To change nickname, use: bus rename $subscriber '$nickname'"
      exit 1
    fi
    # else: same nickname provided, continue with rejoin
  else
    # New subscriber: auto-generate or validate provided nickname
    if [[ -z "$nickname" ]]; then
      local count
      count=$(jq -r --arg type "$agent_type" \
        '.subscribers | to_entries[] |
         select(.value.agent_type == $type) | .key' \
        "$BUS_DIR/bus.json" 2>/dev/null | wc -l | tr -d ' ')
      nickname="${agent_type}-$((count + 1))"
    fi

    # Check nickname uniqueness for new subscribers
    local existing
    existing=$(resolve_nickname "$nickname" 2>/dev/null || echo "")
    if [[ -n "$existing" && "$existing" != "$subscriber" ]]; then
      log_error "Nickname '$nickname' already in use by $existing"
      exit 1
    fi
  fi

  log_info "Joining event bus: $subscriber (nickname: $nickname)"

  # Set terminal window title with session id and nickname
  if [[ -n "$nickname" ]]; then
    local title="[bus:${session_id}] ${nickname}"
  else
    local title="[bus:${session_id}]"
  fi

  # Optional: set terminal title (for human identification; disabled by default to avoid stdout pollution)
  if [[ "${AI_BUS_SET_TITLE:-0}" == "1" ]]; then
    echo -ne "\\033]0;${title}\\007"
  fi

  # Update bus.json
  local tmp_file
  tmp_file=$(mktemp)

  local tmux_pane="${TMUX_PANE:-}"
  local tmux_session="${TMUX_SESSION:-}"
  local tty_path=""
  tty_path="$(tty 2>/dev/null || true)"
  if [[ "$tty_path" == "not a tty" ]]; then
    tty_path=""
  fi

  # Clean up old subscribers on same tty (avoid duplicate subscriptions)
  if [[ -n "$tty_path" ]]; then
    for old_queue in "$BUS_DIR/queues"/*/tty; do
      if [[ -f "$old_queue" ]]; then
        old_tty=$(cat "$old_queue")
        if [[ "$old_tty" == "$tty_path" ]]; then
          old_dir=$(dirname "$old_queue")
          old_safe_name=$(basename "$old_dir")
          old_subscriber="${old_safe_name/_/:}"
          if [[ "$old_subscriber" != "$subscriber" ]]; then
            log_info "Cleaning up old subscription on same tty: $old_subscriber"
            rm -rf "$old_dir"
            rm -f "$BUS_DIR/offsets/${old_safe_name}.offset"
            # Remove from bus.json
            jq --arg name "$old_subscriber" 'del(.subscribers[$name])' "$BUS_DIR/bus.json" > "$tmp_file" && mv "$tmp_file" "$BUS_DIR/bus.json"
            tmp_file=$(mktemp)
          fi
        fi
      fi
    done
  fi

  jq --arg name "$subscriber" \
     --arg agent_type "$agent_type" \
     --arg instance_id "$session_id" \
     --arg nickname "$nickname" \
     --arg tmux_pane "$tmux_pane" \
     --arg tmux_session "$tmux_session" \
     --arg tty "$tty_path" \
     --arg ts "$(get_timestamp)" \
     --arg pid "${UFOO_PARENT_PID:-$PPID}" \
     --arg cwd "$(pwd)" \
     --arg launch_mode "${UFOO_LAUNCH_MODE:-unknown}" \
     '
     .subscribers[$name] = {
        "agent_type": $agent_type,
        "instance_id": $instance_id,
        "nickname": $nickname,
        "tmux_pane": (if $tmux_pane != "" then $tmux_pane else null end),
        "tmux_session": (if $tmux_session != "" then $tmux_session else null end),
        "tty": (if $tty != "" then $tty else null end),
        "pid": ($pid | tonumber),
        "joined_at": $ts,
        "status": "active",
        "last_heartbeat": $ts,
        "launch_mode": $launch_mode
      }
     |
     .agent_types[$agent_type].instances = (
       (.agent_types[$agent_type].instances // []) + [$instance_id] | unique
     )
     |
     .agent_types[$agent_type].active_count = (
       .subscribers | to_entries | map(select(.value.agent_type == $agent_type and .value.status == "active")) | length
     )
     ' "$BUS_DIR/bus.json" > "$tmp_file"

  mv "$tmp_file" "$BUS_DIR/bus.json"

  # Create offset file
  cat > "$BUS_DIR/offsets/${safe_name}.offset" << EOF
{
  "subscriber": "$subscriber",
  "current_seq": 0,
  "last_consumed_at": "$(get_timestamp)"
}
EOF

  # Create queue directory
  mkdir -p "$BUS_DIR/queues/${safe_name}"
  # Best-effort: persist tty for other scripts (e.g. injection) without parsing bus.json
  if [[ -n "$tty_path" ]]; then
    echo "$tty_path" > "$BUS_DIR/queues/${safe_name}/tty"
  fi

  # Record tty device (for later inject targeting)
  local current_tty
  current_tty=$(tty 2>/dev/null || echo "")
  if [[ -n "$current_tty" && "$current_tty" != "not a tty" ]]; then
    echo "$current_tty" > "$BUS_DIR/queues/${safe_name}/tty"
  fi

  # Publish join event
  local seq
  seq=$(get_next_seq)
  local today_file="$BUS_DIR/events/$(get_date).jsonl"
  echo "{\"seq\":$seq,\"ts\":\"$(get_timestamp)\",\"type\":\"system\",\"event\":\"agent_joined\",\"publisher\":\"$subscriber\",\"data\":{\"agent_type\":\"$agent_type\",\"instance_id\":\"$session_id\"}}" >> "$today_file"

  log_ok "Joined event bus"
  echo ""
  echo -e "${CYAN}My identity: $subscriber${NC}"
  echo ""

  # Check pending events
  cmd_check "$subscriber"

  # Output subscriber ID
  echo "$subscriber"
}

# ============================================================================
# Command: check (check pending events)
# ============================================================================

cmd_check() {
  local subscriber="${1:-}"
  local auto_ack="${2:-}"

  if [[ -z "$subscriber" ]]; then
    log_error "Usage: bus check <subscriber-id> [--ack]"
    exit 1
  fi

  ensure_bus

  local safe_name
  safe_name=$(subscriber_to_safe_name "$subscriber")
  local queue_file="$BUS_DIR/queues/${safe_name}/pending.jsonl"

  if [[ -f "$queue_file" && -s "$queue_file" ]]; then
    local count
    count=$(wc -l < "$queue_file" | tr -d ' ')
    log_warn "You have $count pending event(s):"
    echo ""
    while IFS= read -r event; do
      local publisher type event_name data
      publisher=$(echo "$event" | jq -r '.publisher')
      type=$(echo "$event" | jq -r '.type')
      event_name=$(echo "$event" | jq -r '.event')
      data=$(echo "$event" | jq -c '.data')
      echo -e "  ${YELLOW}@you${NC} from ${CYAN}$publisher${NC}"
      echo -e "  Type: $type/$event_name"
      echo -e "  Content: $data"
      echo ""
    done < "$queue_file"

    # Auto-ack if requested, or show hint
    if [[ "$auto_ack" == "--ack" ]]; then
      : > "$queue_file"
      log_ok "Messages acknowledged and cleared"
    else
      echo -e "${CYAN}After handling, run: ufoo bus ack $subscriber${NC}"
    fi
  else
    log_ok "No pending events"
  fi
}

# ============================================================================
# Command: ack (acknowledge/clear pending messages)
# ============================================================================

cmd_ack() {
  local subscriber="${1:-}"

  if [[ -z "$subscriber" ]]; then
    log_error "Usage: bus ack <subscriber-id>"
    exit 1
  fi

  ensure_bus

  local safe_name
  safe_name=$(subscriber_to_safe_name "$subscriber")
  local queue_file="$BUS_DIR/queues/${safe_name}/pending.jsonl"

  if [[ -f "$queue_file" && -s "$queue_file" ]]; then
    local count
    count=$(wc -l < "$queue_file" | tr -d ' ')
    # Clear the queue
    : > "$queue_file"
    log_ok "Acknowledged and cleared $count message(s)"
  else
    log_ok "No pending messages to acknowledge"
  fi
}

# ============================================================================
# Command: send (send targeted message)
# ============================================================================

cmd_send() {
  local target="${1:-}"
  local message="${2:-}"

  # Auto-detect publisher: prefer env var, otherwise build from session ID
  local publisher="${AI_BUS_PUBLISHER:-}"
  if [[ -z "$publisher" ]]; then
    if [[ -n "${CODEX_SESSION_ID:-}" ]]; then
      publisher="codex:${CODEX_SESSION_ID}"
    elif [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
      publisher="claude-code:${CLAUDE_SESSION_ID}"
    else
      publisher="unknown"
    fi
  fi

  if [[ -z "$target" || -z "$message" ]]; then
    log_error "Usage: context-bus send <target> <message>"
    log_error "Example: context-bus send claude-code:abc123 'Please help me review'"
    exit 1
  fi

  ensure_bus

  local seq
  seq=$(get_next_seq)
  local today_file="$BUS_DIR/events/$(get_date).jsonl"

  # Build event
  local event_json
  event_json=$(jq -cn \
    --argjson seq "$seq" \
    --arg ts "$(get_timestamp)" \
    --arg publisher "$publisher" \
    --arg target "$target" \
    --arg message "$message" \
    '{
      seq: $seq,
      ts: $ts,
      type: "message",
      event: "targeted",
      publisher: $publisher,
      target: $target,
      data: { message: $message }
    }')

  echo "$event_json" >> "$today_file"

  # Write to target queue
  local matching_subscribers
  matching_subscribers=$(jq -r '.subscribers | keys[]' "$BUS_DIR/bus.json")

  for sub in $matching_subscribers; do
    if target_matches "$target" "$sub"; then
      local safe_name
      safe_name=$(subscriber_to_safe_name "$sub")
      mkdir -p "$BUS_DIR/queues/${safe_name}"
      echo "$event_json" >> "$BUS_DIR/queues/${safe_name}/pending.jsonl"
    fi
  done

  log_ok "Message sent: seq=$seq -> $target"
}

# ============================================================================
# Command: broadcast (broadcast message)
# ============================================================================

cmd_broadcast() {
  local message="${1:-}"
  local publisher="${AI_BUS_PUBLISHER:-unknown}"

  if [[ -z "$message" ]]; then
    log_error "Usage: context-bus broadcast <message>"
    exit 1
  fi

  ensure_bus

  local seq
  seq=$(get_next_seq)
  local today_file="$BUS_DIR/events/$(get_date).jsonl"

  local event_json
  event_json=$(jq -cn \
    --argjson seq "$seq" \
    --arg ts "$(get_timestamp)" \
    --arg publisher "$publisher" \
    --arg message "$message" \
    '{
      seq: $seq,
      ts: $ts,
      type: "message",
      event: "broadcast",
      publisher: $publisher,
      data: { message: $message }
    }')

  echo "$event_json" >> "$today_file"

  # Fan out broadcast to all subscriber queues
  local matching_subscribers
  matching_subscribers=$(jq -r '.subscribers | keys[]' "$BUS_DIR/bus.json")

  for sub in $matching_subscribers; do
    local safe_name
    safe_name=$(subscriber_to_safe_name "$sub")
    mkdir -p "$BUS_DIR/queues/${safe_name}"
    echo "$event_json" >> "$BUS_DIR/queues/${safe_name}/pending.jsonl"
  done

  log_ok "Broadcast sent: seq=$seq"
}

# ============================================================================
# Command: status
# ============================================================================

cmd_status() {
  ensure_bus

  echo ""
  echo -e "${CYAN}=== Event Bus Status ===${NC}"
  echo ""

  local bus_id
  bus_id=$(jq -r '.bus_id' "$BUS_DIR/bus.json")
  echo "Bus ID: $bus_id"
  echo ""

  echo -e "${CYAN}Online subscribers:${NC}"
  local online=()
  while IFS=$'\t' read -r sub_id sub_pid sub_nick; do
    [[ -z "$sub_id" ]] && continue
    if is_pid_alive "$sub_pid"; then
      if [[ -n "$sub_nick" && "$sub_nick" != "null" ]]; then
        online+=("$sub_id ($sub_nick)")
      else
        online+=("$sub_id")
      fi
    fi
  done < <(jq -r '.subscribers | to_entries[] | select(.value.status == "active") | "\(.key)\t\(.value.pid // 0)\t\(.value.nickname // "")"' "$BUS_DIR/bus.json")
  if [[ ${#online[@]} -eq 0 ]]; then
    echo "  (none)"
  else
    printf "  %s\n" "${online[@]}"
  fi
  echo ""

  echo -e "${CYAN}Event statistics:${NC}"
  local total=0
  shopt -s nullglob
  for f in "$BUS_DIR/events"/*.jsonl; do
    if [[ -f "$f" ]]; then
      local count
      count=$(wc -l < "$f" | tr -d ' ')
      total=$((total + count))
      echo "  $(basename "$f"): $count events"
    fi
  done
  echo "  Total: $total events"
}

# ============================================================================
# Command: consume
# ============================================================================

cmd_consume() {
  local subscriber="${1:-}"
  local limit="${2:-10}"

  if [[ -z "$subscriber" ]]; then
    log_error "Usage: context-bus consume <subscriber-id> [limit]"
    exit 1
  fi

  ensure_bus

  local safe_name
  safe_name=$(subscriber_to_safe_name "$subscriber")
  local offset_file="$BUS_DIR/offsets/${safe_name}.offset"

  if [[ ! -f "$offset_file" ]]; then
    log_error "Subscriber not registered: $subscriber"
    exit 1
  fi

  local current_seq
  current_seq=$(jq -r '.current_seq' "$offset_file")

  local events=()
  local max_seq=$current_seq

  shopt -s nullglob
  for event_file in "$BUS_DIR/events"/*.jsonl; do
    while IFS= read -r line; do
      local seq target
      seq=$(echo "$line" | jq -r '.seq')
      target=$(echo "$line" | jq -r '.target // ""')

      if [[ $seq -gt $current_seq ]]; then
        if target_matches "$target" "$subscriber"; then
          events+=("$line")
          [[ $seq -gt $max_seq ]] && max_seq=$seq
        fi
      fi
    done < "$event_file"
  done

  local count=0
  for event in "${events[@]}"; do
    [[ $count -ge $limit ]] && break
    echo "$event"
    ((count++))
  done

  if [[ $max_seq -gt $current_seq ]]; then
    jq --argjson seq "$max_seq" --arg ts "$(get_timestamp)" \
       '.current_seq = $seq | .last_consumed_at = $ts' \
       "$offset_file" > "${offset_file}.tmp"
    mv "${offset_file}.tmp" "$offset_file"
  fi
}

# ============================================================================
# Command: resolve (smart routing - find target agent)
# ============================================================================

cmd_resolve() {
  local my_id="${1:-}"
  local target_type="${2:-}"

  if [[ -z "$my_id" || -z "$target_type" ]]; then
    log_error "Usage: bus resolve <my-subscriber-id> <target-type>"
    log_error "Example: bus resolve claude-code:abc123 codex"
    exit 1
  fi

  ensure_bus

  echo ""
  echo -e "${CYAN}=== Smart Routing: Finding $target_type ===${NC}"
  echo ""

  # Get all active subscribers of target type (excluding myself) that are currently online.
  local candidates=()
  while IFS=$'\t' read -r candidate_id candidate_pid; do
    [[ -z "$candidate_id" ]] && continue
    if is_pid_alive "$candidate_pid"; then
      candidates+=("$candidate_id")
    fi
  done < <(jq -r --arg type "$target_type" --arg me "$my_id" '
    .subscribers | to_entries[] |
    select(.value.agent_type == $type and .key != $me and .value.status == "active") |
    "\(.key)\t\(.value.pid // 0)"
  ' "$BUS_DIR/bus.json")

  if [[ ${#candidates[@]} -eq 0 ]]; then
    log_warn "No online $target_type agents found"
    echo ""
    echo "RESULT: none"
    return 0
  fi

  # Count candidates
  local count
  count=${#candidates[@]}

  if [[ "$count" -eq 1 ]]; then
    echo -e "${GREEN}Only one $target_type found:${NC} ${candidates[0]}"
    echo ""
    echo "RESULT: ${candidates[0]}"
    return 0
  fi

  # Multiple candidates - show each with message history
  echo -e "${YELLOW}Multiple $target_type agents found ($count):${NC}"
  echo ""

  for candidate in "${candidates[@]}"; do
    local nickname
    nickname=$(jq -r --arg id "$candidate" '.subscribers[$id].nickname // ""' "$BUS_DIR/bus.json")
    local joined_at
    joined_at=$(jq -r --arg id "$candidate" '.subscribers[$id].joined_at // ""' "$BUS_DIR/bus.json")

    echo -e "${CYAN}[$candidate]${NC}"
    if [[ -n "$nickname" && "$nickname" != "null" ]]; then
      echo "  Nickname: $nickname"
    fi
    echo "  Joined: $joined_at"

    # Find recent message history with this candidate
    echo "  Recent messages:"
    local msg_count=0
    shopt -s nullglob
    for event_file in "$BUS_DIR/events"/*.jsonl; do
      while IFS= read -r line; do
        local publisher target msg_preview
        publisher=$(echo "$line" | jq -r '.publisher // ""')
        target=$(echo "$line" | jq -r '.target // ""')

        # Check if this message involves both my_id and candidate
        if [[ ("$publisher" == "$my_id" && "$target" == "$candidate") || \
              ("$publisher" == "$candidate" && "$target" == "$my_id") ]]; then
          msg_preview=$(echo "$line" | jq -r '.data.message // "" | .[0:80]')
          local direction
          if [[ "$publisher" == "$my_id" ]]; then
            direction="→ sent"
          else
            direction="← recv"
          fi
          echo "    $direction: $msg_preview..."
          ((msg_count++))
          if [[ $msg_count -ge 3 ]]; then
            break 2
          fi
        fi
      done < "$event_file"
    done

    if [[ $msg_count -eq 0 ]]; then
      echo "    (no message history)"
    fi
    echo ""
  done

  echo "---"
  echo "CANDIDATES: ${candidates[*]}"
  echo ""
  echo ""
  echo -e "${CYAN}Hint: Use message history and context to choose the right target.${NC}"
  echo "If unsure, you can broadcast to all: ufoo bus send \"$target_type\" \"message\""
}

# ============================================================================
# Command: rename (set/change nickname)
# ============================================================================

cmd_rename() {
  local subscriber="${1:-}"
  local new_nickname="${2:-}"

  if [[ -z "$subscriber" || -z "$new_nickname" ]]; then
    log_error "Usage: bus rename <subscriber-id> <new-nickname>"
    log_error "Example: bus rename claude-code:abc123 'architect'"
    exit 1
  fi

  ensure_bus

  # Check subscriber exists
  local exists
  exists=$(jq -r --arg id "$subscriber" '.subscribers[$id] // empty' "$BUS_DIR/bus.json")
  if [[ -z "$exists" ]]; then
    log_error "Subscriber not found: $subscriber"
    exit 1
  fi

  # Check nickname uniqueness
  local existing
  existing=$(resolve_nickname "$new_nickname" 2>/dev/null || echo "")
  if [[ -n "$existing" && "$existing" != "$subscriber" ]]; then
    log_error "Nickname '$new_nickname' already in use by $existing"
    exit 1
  fi

  # Get old nickname
  local old_nickname
  old_nickname=$(jq -r --arg id "$subscriber" '.subscribers[$id].nickname // ""' "$BUS_DIR/bus.json")

  # Update nickname
  local tmp_file
  tmp_file=$(mktemp)

  jq --arg id "$subscriber" \
     --arg nick "$new_nickname" \
     '.subscribers[$id].nickname = $nick' \
     "$BUS_DIR/bus.json" > "$tmp_file"

  mv "$tmp_file" "$BUS_DIR/bus.json"

  # Publish rename event
  local seq
  seq=$(get_next_seq)
  local today_file="$BUS_DIR/events/$(get_date).jsonl"

  local event_json
  event_json=$(jq -cn \
    --argjson seq "$seq" \
    --arg ts "$(get_timestamp)" \
    --arg subscriber "$subscriber" \
    --arg old_nick "$old_nickname" \
    --arg new_nick "$new_nickname" \
    '{
      seq: $seq,
      ts: $ts,
      type: "system",
      event: "agent_renamed",
      publisher: $subscriber,
      data: {
        subscriber: $subscriber,
        old_nickname: $old_nick,
        new_nickname: $new_nick
      }
    }')

  echo "$event_json" >> "$today_file"

  if [[ -n "$old_nickname" ]]; then
    log_ok "Renamed $subscriber: '$old_nickname' -> '$new_nickname'"
  else
    log_ok "Set nickname for $subscriber: '$new_nickname'"
  fi
}

# ============================================================================
# Command: leave
# ============================================================================

cmd_leave() {
  local subscriber="${1:-}"

  if [[ -z "$subscriber" ]]; then
    log_error "Usage: context-bus leave <subscriber-id>"
    exit 1
  fi

  ensure_bus

  log_info "Leaving event bus: $subscriber"

  # Update status to offline
  local tmp_file
  tmp_file=$(mktemp)

  jq --arg name "$subscriber" \
     '.subscribers[$name].status = "offline"' \
     "$BUS_DIR/bus.json" > "$tmp_file"

  mv "$tmp_file" "$BUS_DIR/bus.json"

  log_ok "Left event bus"
}

# ============================================================================
# Command: alert/listen/autotrigger (helpers)
# ============================================================================

cmd_alert() {
  local subscriber="${1:-}"
  if [[ -z "$subscriber" ]]; then
    log_error "Usage: bus alert <subscriber-id> [interval] [--notify|--daemon|--stop|...]"
    exit 1
  fi
  if [[ ! -x "$SCRIPT_DIR/bus-alert.sh" ]]; then
    log_error "Missing script: $SCRIPT_DIR/bus-alert.sh"
    exit 1
  fi
  exec bash "$SCRIPT_DIR/bus-alert.sh" "$@"
}

cmd_listen() {
  local subscriber="${1:-}"
  if [[ -z "$subscriber" ]]; then
    log_error "Usage: bus listen <subscriber-id> [--from-beginning|--reset|...]"
    exit 1
  fi
  if [[ ! -x "$SCRIPT_DIR/bus-listen.sh" ]]; then
    log_error "Missing script: $SCRIPT_DIR/bus-listen.sh"
    exit 1
  fi
  exec bash "$SCRIPT_DIR/bus-listen.sh" "$@"
}

cmd_autotrigger() {
  if [[ ! -x "$SCRIPT_DIR/bus-autotrigger.sh" ]]; then
    log_error "Missing script: $SCRIPT_DIR/bus-autotrigger.sh"
    exit 1
  fi
  exec bash "$SCRIPT_DIR/bus-autotrigger.sh" "$@"
}

# ============================================================================
# Main entry
# ============================================================================

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    init)      cmd_init "$@" ;;
    join)      cmd_join "$@" ;;
    check)     cmd_check "$@" ;;
    ack)       cmd_ack "$@" ;;
    send)      cmd_send "$@" ;;
    broadcast) cmd_broadcast "$@" ;;
    status)    cmd_status "$@" ;;
    consume)   cmd_consume "$@" ;;
    resolve)   cmd_resolve "$@" ;;
    rename|nick) cmd_rename "$@" ;;
    leave)     cmd_leave "$@" ;;
    alert)     cmd_alert "$@" ;;
    listen)    cmd_listen "$@" ;;
    autotrigger) cmd_autotrigger "$@" ;;
    help|--help|-h)
      echo "bus - Project-level Agent event bus"
      echo ""
      echo "Usage: bus <command> [options]"
      echo ""
      echo "Commands:"
      echo "  init                              Initialize event bus"
      echo "  join [session-id] [type] [nick]   Join bus (auto-generates nickname if omitted)"
      echo "  check <subscriber>                Check pending events"
      echo "  ack <subscriber>                  Acknowledge and clear pending messages"
      echo "  resolve <my-id> <target-type>     Smart routing: find target agent"
      echo "  rename <subscriber> <nickname>    Set/change agent nickname"
      echo "  send <target> <message>           Send targeted message (supports nickname)"
      echo "  broadcast <message>               Broadcast message"
      echo "  status                            View bus status"
      echo "  consume <subscriber>              Consume events"
      echo "  leave <subscriber>                Leave bus"
      echo "  alert <subscriber>                Background alerts (no auto-execute)"
      echo "  listen <subscriber>               Foreground listener, print new messages"
      echo "  autotrigger start|stop|status     Unattended auto-execute (tmux)"
      echo ""
      echo "Examples:"
      echo "  bus join abc123 claude-code \"architect\""
      echo "  bus rename claude-code:abc123 \"dev-lead\""
      echo "  bus send architect \"Please help me review\""
      echo "  bus send claude-code:abc123 \"Please help me review\""
      ;;
    *)
      log_error "Unknown command: $cmd"
      exit 1
      ;;
  esac
}

main "$@"
