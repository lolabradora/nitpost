#!/bin/sh
# Build the upload separately from the unpacked extension with its persistent ID.
set -eu
dest=${1:?Pass an absolute ZIP output path}
case "$dest" in /*) ;; *) echo 'Use an absolute output path' >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/store"
rsync -r --exclude=.DS_Store extension/ "$tmp/store/"
jq 'del(.key)' extension/manifest.json > "$tmp/store/manifest.json"
(cd "$tmp/store" && zip -qr "$tmp/upload.zip" .)
mv "$tmp/upload.zip" "$dest"
