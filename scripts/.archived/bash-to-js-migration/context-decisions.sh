#!/usr/bin/env bash
set -euo pipefail

# context-decisions.sh
# Show latest decisions from project context

usage() {
  cat <<'EOF'
context-decisions.sh

Show recent decisions from a decision log directory.

Default behavior:
  - Use .ufoo/context/DECISIONS/ (project-local decision log)

Usage:
  bash scripts/context-decisions.sh [options]

Options:
  -n <num>    Show last N decisions (default: 1)
  -l          List all decisions (titles only)
  -a          Show all decisions (full content)
  -d <dir>    Use a specific decisions directory
  -s <status> Filter by status: open, resolved, wontfix (default: open)
              Use -s all to show all statuses
  --help      Show this help

Frontmatter format:
  ---
  status: open | resolved | wontfix
  resolved_by: <agent>      # optional, who resolved it
  resolved_at: <date>       # optional, when resolved
  ---
EOF
}

DECISIONS_DIR="${AI_CONTEXT_DECISIONS_DIR:-}"
NUM=1
LIST_ONLY=0
SHOW_ALL=0
STATUS_FILTER="open"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n)
      NUM="$2"
      shift 2
      ;;
    -l)
      LIST_ONLY=1
      shift
      ;;
    -a)
      SHOW_ALL=1
      shift
      ;;
    -d|--dir)
      DECISIONS_DIR="$2"
      shift 2
      ;;
    -s)
      STATUS_FILTER="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Default decisions directory
if [[ -z "${DECISIONS_DIR}" ]]; then
  DECISIONS_DIR=".ufoo/context/DECISIONS"
fi

# Extract status from frontmatter (defaults to "open" if no frontmatter)
get_status() {
  local file="$1"
  local status
  # Check if file starts with ---
  if head -1 "$file" | grep -q '^---$'; then
    status=$(awk '/^---$/{if(++c==2)exit} c==1 && /^status:/{print $2}' "$file")
  fi
  echo "${status:-open}"
}

# Check if file matches status filter
matches_status() {
  local file="$1"
  if [[ "$STATUS_FILTER" == "all" ]]; then
    return 0
  fi
  local status
  status=$(get_status "$file")
  [[ "$status" == "$STATUS_FILTER" ]]
}

if [[ ! -d "$DECISIONS_DIR" ]]; then
  echo "No decisions directory found at $DECISIONS_DIR" >&2
  exit 0
fi

# Get sorted decision files (newest first by filename)
FILES=()
while IFS= read -r f; do
  FILES+=("$f")
done < <(ls -1 "$DECISIONS_DIR"/*.md 2>/dev/null | sort -r)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No decisions found."
  exit 0
fi

if [[ $LIST_ONLY -eq 1 ]]; then
  count=0
  output=""
  for f in "${FILES[@]}"; do
    if matches_status "$f"; then
      status=$(get_status "$f")
      # Get title (skip frontmatter if present)
      if head -1 "$f" | grep -q '^---$'; then
        title=$(awk '/^---$/{if(++c==2){getline; print; exit}}' "$f" | sed 's/^# //')
      else
        title=$(head -1 "$f" | sed 's/^# //')
      fi
      output+="  [$status] $(basename "$f"): $title"$'\n'
      ((count++))
    fi
  done
  echo "=== Decisions (${count} ${STATUS_FILTER}, ${#FILES[@]} total) ==="
  printf "%s" "$output"
  exit 0
fi

# Filter files by status
FILTERED_FILES=()
for f in "${FILES[@]}"; do
  if matches_status "$f"; then
    FILTERED_FILES+=("$f")
  fi
done

if [[ ${#FILTERED_FILES[@]} -eq 0 ]]; then
  echo "No decisions with status '$STATUS_FILTER' found."
  exit 0
fi

if [[ $SHOW_ALL -eq 1 ]]; then
  NUM=${#FILTERED_FILES[@]}
fi

echo "=== Latest Decision(s) [${STATUS_FILTER}] ==="
echo ""

for ((i=0; i<NUM && i<${#FILTERED_FILES[@]}; i++)); do
  f="${FILTERED_FILES[$i]}"
  status=$(get_status "$f")
  echo "--- $(basename "$f") [$status] ---"
  cat "$f"
  echo ""
done
