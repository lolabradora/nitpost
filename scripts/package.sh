#!/bin/sh
# Maintainer build, run from any directory on macOS with the aarch64-apple-darwin target.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cargo build --manifest-path companion/Cargo.toml --release --locked --target aarch64-apple-darwin
cp companion/target/aarch64-apple-darwin/release/nitpost "$tmp/nitpost"
[ "$(lipo -archs "$tmp/nitpost")" = arm64 ]
if [ -n "${NITPOST_SIGN_IDENTITY:-}" ]; then
    /usr/bin/codesign --force --options runtime --timestamp --sign "$NITPOST_SIGN_IDENTITY" "$tmp/nitpost"
else
    /usr/bin/codesign --force --sign - "$tmp/nitpost"
fi
/usr/bin/codesign --verify --all-architectures "$tmp/nitpost"
mkdir "$tmp/extension"
/usr/bin/rsync -r --exclude=".DS_Store" extension/ "$tmp/extension/"
mkdir -p "$tmp/scripts" "$tmp/skills/nitpost" dist
cp scripts/install-skill.sh "$tmp/scripts/"
cp skills/nitpost/SKILL.md "$tmp/skills/nitpost/"
asset=nitpost-macos-arm64.tar.gz
COPYFILE_DISABLE=1 /usr/bin/tar -czf "$tmp/$asset" -C "$tmp" nitpost extension scripts skills
mv "$tmp/$asset" "dist/$asset"
(cd "$tmp" && /usr/bin/zip -q nitpost-notary.zip nitpost)
sh scripts/package-chrome.sh "$tmp/nitpost-chrome.zip"
mv "$tmp/nitpost-notary.zip" "$tmp/nitpost-chrome.zip" dist/
hash=$(shasum -a 256 "dist/$asset" | cut -d ' ' -f1)
sed -i '' "s/^    digest=.*/    digest=$hash/" install.sh
echo "Packaged $asset ($hash)"
