#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d ".ufoo" ]]; then
  echo "FAIL: .ufoo not found. Run: ufoo init" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$repo_root/scripts/banner.sh" ]]; then
  # shellcheck disable=SC1090
  source "$repo_root/scripts/banner.sh"
fi

agent_type="claude"
session_id="${CLAUDE_SESSION_ID:-}"
if [[ -n "${CODEX_SESSION_ID:-}" ]]; then
  agent_type="codex"
  session_id="$CODEX_SESSION_ID"
fi

subscriber=""
if [[ -f ".ufoo/bus/bus.json" ]]; then
  cur_tty="$(tty 2>/dev/null || true)"
  if [[ "$cur_tty" == /dev/* ]]; then
    subscriber="$(
      jq -r --arg tty "$cur_tty" \
        '.subscribers | to_entries[] | select(.value.tty == $tty) | .key' \
        .ufoo/bus/bus.json 2>/dev/null | head -1
    )"
  fi
fi

if [[ -z "$subscriber" && -n "$session_id" ]]; then
  if [[ "$agent_type" == "codex" ]]; then
    subscriber="codex:$session_id"
  else
    subscriber="claude-code:$session_id"
  fi
fi

if [[ -z "$session_id" && "$subscriber" == *:* ]]; then
  session_id="${subscriber#*:}"
fi
if [[ -z "$session_id" ]]; then
  session_id="unknown"
fi

if declare -F show_banner >/dev/null 2>&1; then
  show_banner "$agent_type" "$session_id" "$subscriber"
else
  echo "=== ufoo status ==="
  echo "Agent: ${subscriber:-$agent_type}"
  echo ""
fi

echo "Project: $(pwd)"

unread_total=0
unread_lines=""
if [[ -d ".ufoo/bus/queues" ]]; then
  shopt -s nullglob
  for queue_file in .ufoo/bus/queues/*/pending.jsonl; do
    [[ -s "$queue_file" ]] || continue
    count=$(wc -l < "$queue_file" | tr -d ' ')
    unread_total=$((unread_total + count))
    safe_name="$(basename "$(dirname "$queue_file")")"
    subscriber_name="$safe_name"
    if [[ -f ".ufoo/bus/bus.json" ]]; then
      subscriber_name="$(
        jq -r --arg safe "$safe_name" \
          '.subscribers | to_entries[] | select((.key|gsub(":";"_")) == $safe) | .key' \
          .ufoo/bus/bus.json 2>/dev/null | head -1
      )"
      [[ -n "$subscriber_name" && "$subscriber_name" != "null" ]] || subscriber_name="$safe_name"
    else
      subscriber_name="${safe_name/_/:}"
    fi
    unread_lines+=$'  - '"$subscriber_name"$': '"$count"$'\n'
  done
  shopt -u nullglob
fi

echo "Unread messages: $unread_total"
if [[ -n "$unread_lines" ]]; then
  printf "%s" "$unread_lines"
fi

decisions_dir=".ufoo/context/DECISIONS"
open_count=0
open_lines=""

get_status() {
  local file="$1"
  local status
  if grep -q "^---$" "$file"; then
    status=$(awk '/^---$/{if(++c==2)exit} c==1 && /^status:/{print $2}' "$file")
  fi
  echo "${status:-open}"
}

get_title() {
  awk '/^#/{sub(/^# */,"");print; exit}' "$1"
}

if [[ -d "$decisions_dir" ]]; then
  shopt -s nullglob
  for f in "$decisions_dir"/*.md; do
    [[ -f "$f" ]] || continue
    status="$(get_status "$f")"
    if [[ "$status" == "open" ]]; then
      open_count=$((open_count + 1))
      title="$(get_title "$f")"
      [[ -z "$title" ]] && title="(no title)"
      open_lines+=$'  - '"$(basename "$f")"$': '"$title"$'\n'
    fi
  done
  shopt -u nullglob
fi

echo "Open decisions: $open_count"
if [[ -n "$open_lines" ]]; then
  printf "%s" "$open_lines"
fi
