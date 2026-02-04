#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
context_mod="$repo_root/modules/context"

if [[ ! -d "$context_mod" ]]; then
  echo "FAIL: missing $context_mod" >&2
  exit 1
fi

bash "$context_mod/scripts/context-lint.sh" >/dev/null

echo "=== ufoo doctor ==="
echo "Monorepo: $repo_root"
echo "Modules:"
echo "- context: $context_mod"
if [[ -d "$repo_root/modules/resources" ]]; then
  echo "- resources: $repo_root/modules/resources"
fi

echo "Status: OK"
