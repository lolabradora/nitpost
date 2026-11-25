#!/bin/sh
set -eu

case "${1:-}" in
  codex) root="${CODEX_HOME:-$HOME/.codex}" ;;
  claude) root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ;;
  *) echo 'Usage: sh scripts/install-skill.sh codex|claude [--update]' >&2; exit 2 ;;
esac
case "$#:${2:-}" in
  1:|2:--update) ;;
  *) echo 'Expected an agent name and optional --update.' >&2; exit 2 ;;
esac
source_dir=$(cd "$(dirname "$0")/../skills/nitpost" && pwd)
dir="$root/skills/nitpost"
mkdir -p "$dir"
dest="$dir/SKILL.md"
if [ -d "$dest" ]; then echo "Expected a file at $dest" >&2; exit 1; fi
if [ -f "$dest" ] && cmp -s "$source_dir/SKILL.md" "$dest"; then
  echo "Already installed at $dest"
  exit 0
fi
tmp=$(mktemp "$dir/.nitpost.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp "$source_dir/SKILL.md" "$tmp"
if [ "${2:-}" = --update ]; then
  mv -f "$tmp" "$dest"
elif ! ln "$tmp" "$dest"; then
  echo "Could not install at $dest. To replace an existing skill file, use --update." >&2
  exit 1
fi
echo "Installed at $dest"
