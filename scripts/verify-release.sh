#!/bin/sh
# Check the exact bytes that will be distributed, independent of the CI build.
set -eu
tag=${1:?Pass the release tag}
[ "$tag" = "v$(jq -r '.version_name // .version' extension/manifest.json)" ]
[ "$tag" = "v$(awk -F '"' '/^version =/ {print $2;exit}' companion/Cargo.toml)" ]
grep -Fq "/download/$tag/" install.sh
asset=dist/nitpost-macos-arm64.tar.gz
expected=$(sed -n 's/^    digest=//p' install.sh)
echo "$expected  $asset" | shasum -a 256 -c -
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$asset" -C "$tmp"
[ "$(lipo -archs "$tmp/nitpost")" = arm64 ]
cmp scripts/install-skill.sh "$tmp/scripts/install-skill.sh"
cmp skills/nitpost/SKILL.md "$tmp/skills/nitpost/SKILL.md"
codesign --verify --strict "$tmp/nitpost"
codesign -v -R='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' "$tmp/nitpost"
codesign -dv --verbose=4 "$tmp/nitpost" 2>&1 | grep -q '(runtime)'
codesign -dv --verbose=4 "$tmp/nitpost" 2>&1 | grep -q '^Timestamp='
unzip -p dist/nitpost-notary.zip nitpost | cmp - "$tmp/nitpost"
diff -qr -x .DS_Store extension "$tmp/extension"
unzip -q dist/nitpost-chrome.zip -d "$tmp/store"
jq 'del(.key)' extension/manifest.json > "$tmp/extension/manifest.json"
diff -qr "$tmp/extension" "$tmp/store"
