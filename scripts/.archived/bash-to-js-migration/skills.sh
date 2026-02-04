#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

skill_roots=()
if [[ -d "$repo_root/SKILLS" ]]; then
  skill_roots+=("$repo_root/SKILLS")
fi
if [[ -d "$repo_root/modules" ]]; then
  while IFS= read -r d; do
    skill_roots+=("$d")
  done < <(find "$repo_root/modules" -maxdepth 2 -type d -name SKILLS | sort)
fi

usage() {
  cat <<'EOFU'
skills

Usage:
  ufoo skills list
  ufoo skills install <name|all> [--target <dir> | --codex | --agents]
EOFU
}

cmd="${1:-}"
shift || true

case "$cmd" in
  list)
    for root in "${skill_roots[@]}"; do
      find "$root" -mindepth 1 -maxdepth 1 -type d -print
    done | sed 's|.*/||' | sort -u
    ;;
  install)
    name="${1:-}"
    shift || true
    if [[ -z "$name" ]]; then
      echo "FAIL: install requires <name|all>" >&2
      exit 1
    fi

    target=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --target)
          target="$2"; shift 2 ;;
        --codex)
          target="${CODEX_HOME:-$HOME/.codex}/skills"; shift ;;
        --agents)
          target="$HOME/.agents/skills"; shift ;;
        *)
          echo "Unknown option: $1" >&2
          usage >&2
          exit 1
          ;;
      esac
    done

    if [[ -z "$target" ]]; then
      echo "FAIL: specify --target/--codex/--agents" >&2
      exit 1
    fi

    mkdir -p "$target"

    find_skill() {
      local skill_name="$1"
      local matches=()
      local root
      for root in "${skill_roots[@]}"; do
        if [[ -f "$root/$skill_name/SKILL.md" ]]; then
          matches+=("$root/$skill_name")
        fi
      done
      if (( ${#matches[@]} == 0 )); then
        echo "FAIL: missing skill '$skill_name'" >&2
        exit 1
      fi
      if (( ${#matches[@]} > 1 )); then
        echo "FAIL: duplicate skill name '$skill_name' in:" >&2
        printf '  - %s\n' "${matches[@]}" >&2
        exit 1
      fi
      echo "${matches[0]}"
    }

    install_one() {
      local skill_name="$1"
      local src_dir
      src_dir="$(find_skill "$skill_name")"
      local src_file="$src_dir/SKILL.md"
      local dst_dir="$target/$skill_name"
      local dst_file="$dst_dir/SKILL.md"

      mkdir -p "$dst_dir"
      cp "$src_file" "$dst_file"
      echo "Installed: $skill_name"
    }

    if [[ "$name" == "all" ]]; then
      while IFS= read -r d; do
        install_one "$d"
      done < <(for root in "${skill_roots[@]}"; do find "$root" -mindepth 1 -maxdepth 1 -type d -print; done | sed 's|.*/||' | sort -u)
    else
      install_one "$name"
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
