#!/bin/sh
# Check the exact bytes that will be distributed, independent of the CI build.
set -eu
tag=${1:?Pass the release tag}
[ "$tag" = "v$(jq -r '.version_name // .version' extension/manifest.json)" ]
[ "$tag" = "v$(awk -F '"' '/^version =/ {print $2;exit}' companion/Cargo.toml)" ]
grep -Fq "/download/$tag/" install.sh
asset=dist/paneparcel-macos-arm64.tar.gz
expected=$(sed -n 's/^    digest=//p' install.sh)
echo "$expected  $asset" | shasum -a 256 -c -
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$asset" -C "$tmp"
[ "$(lipo -archs "$tmp/paneparcel")" = arm64 ]
codesign --verify --strict "$tmp/paneparcel"
codesign -v -R='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' "$tmp/paneparcel"
codesign -dv --verbose=4 "$tmp/paneparcel" 2>&1 | grep -q '(runtime)'
codesign -dv --verbose=4 "$tmp/paneparcel" 2>&1 | grep -q '^Timestamp='
unzip -p dist/paneparcel-notary.zip paneparcel | cmp - "$tmp/paneparcel"
diff -qr -x .DS_Store extension "$tmp/extension"
unzip -q dist/paneparcel-chrome.zip -d "$tmp/store"
diff -qr -x .DS_Store extension "$tmp/store"
