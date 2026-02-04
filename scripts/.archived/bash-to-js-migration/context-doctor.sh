#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
context-doctor.sh

Quick diagnostics for context installations.

Usage:
  bash scripts/context-doctor.sh
  bash scripts/context-doctor.sh --project <path-to-project-context>

What it checks:
  - Runs context-lint (protocol or project)
  - Verifies decision listing works
  - Warns if ~/.ufoo/modules/context is missing
EOF
}

MODE="protocol"
PROJECT_PATH=""
REPO_ROOT="$(pwd)"
CONTEXT_MODULE_PATH="$REPO_ROOT/modules/context"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      MODE="project"
      PROJECT_PATH="$2"
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

echo "=== context doctor ==="
echo "Reminder: If you provide evaluation/recommendation/plan, write a decision before replying."

if [[ "$MODE" == "project" ]]; then
  if [[ -z "$PROJECT_PATH" ]]; then
    echo "FAIL: --project requires a path" >&2
    exit 1
  fi
  echo "Mode: project"
  echo "Project: $PROJECT_PATH"
  bash scripts/context-lint.sh --project "$PROJECT_PATH"
  bash scripts/context-decisions.sh -n 1 -d "$PROJECT_PATH/DECISIONS" >/dev/null
else
  echo "Mode: protocol"
  # In the ufoo monorepo, the protocol module lives under modules/context.
  if [[ -d "$CONTEXT_MODULE_PATH" && -f "$CONTEXT_MODULE_PATH/SYSTEM.md" ]]; then
    bash "$CONTEXT_MODULE_PATH/scripts/context-lint.sh"
  else
    bash scripts/context-lint.sh
  fi
  bash scripts/context-decisions.sh -n 1 >/dev/null 2>&1 || true
fi

if [[ ! -d "${HOME}/.ufoo/modules/context" ]]; then
  echo "WARN: ${HOME}/.ufoo/modules/context not found (install via ufoo for best UX)"
fi

echo "Status: OK"
