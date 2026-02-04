#!/usr/bin/env bash
set -euo pipefail

MODULE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
context-lint.sh

Validate context protocol/project context structure.

Usage:
  bash scripts/context-lint.sh
  bash scripts/context-lint.sh --project <path-to-project-context>

Exit codes:
  0  OK
  1  Validation failed
EOF
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILED=1
}

check_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    fail "Missing file: $path"
  fi
}

check_dir() {
  local path="$1"
  if [[ ! -d "$path" ]]; then
    fail "Missing directory: $path"
  fi
}

check_any_glob() {
  local pattern="$1"
  shopt -s nullglob
  local matches=($pattern)
  shopt -u nullglob
  if (( ${#matches[@]} == 0 )); then
    fail "Missing: $pattern"
  fi
}

lint_protocol_repo() {
  check_file "$MODULE_ROOT/README.md"
  check_file "$MODULE_ROOT/SYSTEM.md"
  check_file "$MODULE_ROOT/RULES.md"
  check_file "$MODULE_ROOT/CONSTRAINTS.md"
  check_file "$MODULE_ROOT/ASSUMPTIONS.md"
  check_file "$MODULE_ROOT/TERMINOLOGY.md"
  check_file "$MODULE_ROOT/DECISION-PROTOCOL.md"
  check_file "$MODULE_ROOT/CONTEXT-STRUCTURE.md"
  check_file "$MODULE_ROOT/HANDOFF.md"
  check_file "$MODULE_ROOT/.gitignore"

  # This repo is a distributable protocol module. It should not ship a project-local .ufoo/context/.
  if ! grep -qE '^[[:space:]]*\.ufoo/context/([[:space:]]*(#.*)?)?$' "$MODULE_ROOT/.gitignore"; then
    fail ".gitignore must ignore .ufoo/context/ (project-local truth) for the protocol repo"
  fi

  # UI/ICONS are resources and must live outside this repo (see decisions); do not allow drift.
  if [[ -d "$MODULE_ROOT/UI" || -d "$MODULE_ROOT/ICONS" ]]; then
    fail "UI/ and ICONS/ must not exist in this repo; they belong in resources"
  fi
}

lint_project_context() {
  local root="$1"
  check_dir "$root"
  check_file "$root/README.md"
  check_file "$root/SYSTEM.md"
  check_file "$root/CONSTRAINTS.md"
  check_file "$root/ASSUMPTIONS.md"
  check_file "$root/TERMINOLOGY.md"
  check_dir "$root/DECISIONS"
}

main() {
  FAILED=0

  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  if [[ "${1:-}" == "--project" ]]; then
    if [[ $# -ne 2 ]]; then
      usage >&2
      exit 1
    fi
    lint_project_context "$2"
  else
    lint_protocol_repo
  fi

  if [[ "$FAILED" -ne 0 ]]; then
    exit 1
  fi

  echo "OK"
}

main "$@"
