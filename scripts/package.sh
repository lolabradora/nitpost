#!/bin/sh
# Maintainer build, run from any directory on macOS with the aarch64-apple-darwin target.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cargo build --manifest-path companion/Cargo.toml --release --locked --target aarch64-apple-darwin
cp companion/target/aarch64-apple-darwin/release/paneparcel "$tmp/paneparcel"
[ "$(lipo -archs "$tmp/paneparcel")" = arm64 ]
if [ -n "${PANE_PARCEL_SIGN_IDENTITY:-}" ]; then
    /usr/bin/codesign --force --options runtime --timestamp --sign "$PANE_PARCEL_SIGN_IDENTITY" "$tmp/paneparcel"
else
    /usr/bin/codesign --force --sign - "$tmp/paneparcel"
fi
/usr/bin/codesign --verify --all-architectures "$tmp/paneparcel"
mkdir "$tmp/extension"
/usr/bin/rsync -r --exclude=".DS_Store" extension/ "$tmp/extension/"
mkdir -p "$tmp/scripts" "$tmp/skills/paneparcel" dist
cp scripts/install-skill.sh "$tmp/scripts/"
cp skills/paneparcel/SKILL.md "$tmp/skills/paneparcel/"
asset=paneparcel-macos-arm64.tar.gz
COPYFILE_DISABLE=1 /usr/bin/tar -czf "$tmp/$asset" -C "$tmp" paneparcel extension scripts skills
mv "$tmp/$asset" "dist/$asset"
(cd "$tmp" && /usr/bin/zip -q paneparcel-notary.zip paneparcel)
sh scripts/package-chrome.sh "$tmp/paneparcel-chrome.zip"
mv "$tmp/paneparcel-notary.zip" "$tmp/paneparcel-chrome.zip" dist/
hash=$(shasum -a 256 "dist/$asset" | cut -d ' ' -f1)
sed -i '' "s/^    digest=.*/    digest=$hash/" install.sh
echo "Packaged $asset ($hash)"
