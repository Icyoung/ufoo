#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
context_mod="$repo_root/modules/context"
bus_mod="$repo_root/modules/bus"
resources_mod="$repo_root/modules/resources"
agents_template="$repo_root/modules/AGENTS.template.md"

usage() {
  cat <<'USAGE'
ufoo init

Usage:
  ufoo init [--modules context[,bus,resources]] [--project <dir>]

Available modules:
  context   - Shared context protocol (.ufoo/context/)
  bus       - Agent event bus (.ufoo/bus/)
  resources - UI/Icons resources

Defaults:
  --modules context
  --project  <current directory>

Examples:
  ufoo init                           # Initialize context only
  ufoo init --modules context,bus     # Initialize context + bus
  ufoo init --modules context,bus,resources  # All modules
USAGE
}

modules="context"
project="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --modules)
      modules="$2"
      shift 2
      ;;
    --project)
      project="$2"
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

# Parse modules list
IFS=',' read -ra MODULE_LIST <<< "$modules"

echo "=== ufoo init ==="
echo "Project directory: $project"
echo "Modules: ${MODULE_LIST[*]}"
echo ""

agents_file="$project/AGENTS.md"
claude_file="$project/CLAUDE.md"

# Ensure AGENTS.md exists
if [[ ! -f "$agents_file" ]]; then
  printf '# Project Instructions\n\n`CLAUDE.md` points to this file. Please keep project instructions here (prefer edits in `AGENTS.md`).\n\n' >"$agents_file"
fi

# CLAUDE.md points to AGENTS.md
printf 'AGENTS.md\n' >"$claude_file"

# ============================================================================
# Core: Create .ufoo directory and docs symlink
# ============================================================================

init_core() {
  echo "[core] Initializing .ufoo core..."

  mkdir -p "$project/.ufoo"

  # Create docs symlink to ufoo installation docs
  local docs_link="$project/.ufoo/docs"
  local docs_target="$repo_root/docs"

  if [[ -d "$docs_target" ]]; then
    rm -f "$docs_link"
    ln -sf "$docs_target" "$docs_link"
    echo "[core] Created docs symlink: .ufoo/docs -> $docs_target"
  fi

  echo "[core] Done"
}

# ============================================================================
# Inject ufoo template into AGENTS.md (always update)
# ============================================================================

inject_agents_template() {
  echo "[template] Injecting ufoo template into AGENTS.md..."

  if [[ ! -f "$agents_template" ]]; then
    echo "[template] Warning: template file not found: $agents_template"
    return
  fi

  local temp_file
  temp_file=$(mktemp)

  # Remove old ufoo block if exists (between <!-- ufoo --> and <!-- /ufoo -->)
  if grep -q "<!-- ufoo -->" "$agents_file" 2>/dev/null; then
    # Remove old block
    sed '/<!-- ufoo -->/,/<!-- \/ufoo -->/d' "$agents_file" > "$temp_file"
    mv "$temp_file" "$agents_file"
    echo "[template] Removed old ufoo template block"
  fi

  # Also remove legacy blocks if they exist
  for legacy in "<!-- ufoo-context -->" "<!-- ufoo-bus -->" "<!-- context -->" "<!-- bus -->"; do
    local end_tag="${legacy/<!-- /<!-- \/}"
    if grep -q "$legacy" "$agents_file" 2>/dev/null; then
      sed "/$legacy/,/$end_tag/d" "$agents_file" > "$temp_file"
      mv "$temp_file" "$agents_file"
      echo "[template] Removed old $legacy block"
    fi
  done

  # Append new template
  echo "" >> "$agents_file"
  cat "$agents_template" >> "$agents_file"

  echo "[template] Template injected"
}

# ============================================================================
# Module: context
# ============================================================================

init_context() {
  echo "[context] Initializing .ufoo/context..."

  if [[ ! -d "$context_mod" ]]; then
    echo "FAIL: missing context module at $context_mod" >&2
    exit 1
  fi

  ufoo_context="$project/.ufoo/context"
  mkdir -p "$ufoo_context/DECISIONS"

  # Create symlinks to templates (not copies)
  local templates_dir="$context_mod/TEMPLATES"
  if [[ -d "$templates_dir" ]]; then
    for tpl in "$templates_dir"/*.md; do
      if [[ -f "$tpl" ]]; then
        local basename=$(basename "$tpl")
        local target="$ufoo_context/$basename"
        # Only create if not exists (preserve user modifications)
        if [[ ! -e "$target" ]]; then
          ln -sf "$tpl" "$target"
        fi
      fi
    done
  fi

  echo "[context] Done: $ufoo_context"
}

# ============================================================================
# Module: bus
# ============================================================================

init_bus() {
  echo "[bus] Initializing .ufoo/bus..."

  if [[ ! -d "$bus_mod" ]]; then
    echo "FAIL: missing bus module at $bus_mod" >&2
    exit 1
  fi

  ufoo_bus="$project/.ufoo/bus"
  mkdir -p "$ufoo_bus"/{events,offsets,queues,logs,pids}

  # Create bus.json if not exists
  if [[ ! -f "$ufoo_bus/bus.json" ]]; then
    local project_name
    project_name=$(basename "$project")
    cat > "$ufoo_bus/bus.json" << EOF
{
  "bus_id": "${project_name}-bus",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "subscribers": {},
  "agent_types": {},
  "config": {
    "poll_interval_ms": 3000,
    "heartbeat_timeout_ms": 30000
  }
}
EOF
  fi

  echo "[bus] Done: $ufoo_bus"
}

# ============================================================================
# Module: resources
# ============================================================================

init_resources() {
  echo "[resources] Initializing resources..."

  if [[ ! -d "$resources_mod" ]]; then
    echo "FAIL: missing resources module at $resources_mod" >&2
    exit 1
  fi

  echo "[resources] Done (resources module needs no initialization, directly reference $resources_mod)"
}

# ============================================================================
# Execute
# ============================================================================

# Always init core first
init_core

# Execute selected modules
for mod in "${MODULE_LIST[@]}"; do
  case "$mod" in
    context)   init_context ;;
    bus)       init_bus ;;
    resources) init_resources ;;
    *)
      echo "Unknown module: $mod" >&2
      exit 1
      ;;
  esac
done

# Always inject/update AGENTS.md template
inject_agents_template

echo ""
echo "=== Initialization complete ==="
