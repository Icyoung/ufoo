#!/usr/bin/env bash
# banner.sh - TUI startup banner for ufoo agents

# Colors
RST='\033[0m'
BLD='\033[1m'
DIM='\033[2m'
CYN='\033[0;36m'
GRN='\033[0;32m'
MAG='\033[0;35m'
WHT='\033[1;37m'
YLW='\033[0;33m'

show_banner() {
  local agent_type="${1:-claude}"
  local session_id="${2:-unknown}"
  local subscriber="${3:-}"
  local daemon_status="${4:-}"

  local ACOL
  if [[ "$agent_type" == "codex" ]]; then
    ACOL="$GRN"
  else
    ACOL="$MAG"
  fi

  # Width matches Codex CLI (inner content = 52)
  local INNER=52
  local W=$INNER

  # Helper: print line with exact padding
  line() {
    local prefix="$1"
    local value="$2"
    local color="$3"
    local prefix_len=${#prefix}
    local value_len=${#value}
    local pad_len=$((INNER - prefix_len - value_len))
    printf "${DIM}│${RST}${prefix}${color}${value}${RST}"
    printf "%${pad_len}s" ""
    printf "${DIM}│${RST}\n"
  }

  echo ""
  printf "${DIM}╭"; printf '─%.0s' $(seq 1 $W); printf "╮${RST}\n"

  # Title line with icon (compute padding from plain text lengths)
  local icon_plain="<○>"
  local title="UFOO · Multi-Agent Protocol"
  local title_pad=$((INNER - 1 - ${#icon_plain} - 1 - ${#title}))
  printf "${DIM}│${RST} ${WHT}${icon_plain}${RST} ${CYN}${BLD}UFOO${RST}${DIM} · Multi-Agent Protocol${RST}"
  printf "%${title_pad}s" ""
  printf "${DIM}│${RST}\n"

  printf "${DIM}├"; printf '─%.0s' $(seq 1 $W); printf "┤${RST}\n"

  # Agent
  if [[ -n "$subscriber" ]]; then
    local sub="$subscriber"
    [[ ${#sub} -gt 36 ]] && sub="${sub:0:33}..."
    line "  Agent   " "$sub" "${ACOL}${BLD}"
  fi

  # Daemon
  if [[ -n "$daemon_status" ]]; then
    line "  Daemon  " "$daemon_status" "${GRN}"
  fi

  # Online agents (daemon handles cleanup of dead agents)
  if [[ -f ".ufoo/bus/bus.json" ]]; then
    local online
    online=$(jq -r '.subscribers | to_entries[] | select(.value.status == "active") | .key' .ufoo/bus/bus.json 2>/dev/null | grep -v "^${subscriber}$" 2>/dev/null | head -5 || true)
    if [[ -n "$online" ]]; then
      printf "${DIM}├"; printf '─%.0s' $(seq 1 $W); printf "┤${RST}\n"
      line "  Online  " "" ""
      while IFS= read -r agent; do
        [[ -z "$agent" ]] && continue
        local a="$agent"
        [[ ${#a} -gt 44 ]] && a="${a:0:41}..."
        line "    · " "$a" "${YLW}"
      done <<< "$online"
    fi
  fi

  printf "${DIM}╰"; printf '─%.0s' $(seq 1 $W); printf "╯${RST}\n"
  echo ""
}

export -f show_banner 2>/dev/null || true
