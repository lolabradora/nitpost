#!/bin/sh
# Bootstrap for the version-matched Apple Silicon macOS release.
set -eu
install_paneparcel() {
    [ "$(uname -s)" = Darwin ] || { echo "PaneParcel requires macOS and Google Chrome." >&2; return 1; }
    [ "$(uname -m)" = arm64 ] || [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || {
        echo "PaneParcel requires an Apple Silicon Mac." >&2; return 1;
    }
    umask 077
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/paneparcel.XXXXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    asset=paneparcel-macos-arm64.tar.gz
    digest=18fdcdfa8fcbafc88dc19fab82f43f8c34a3a0d6bacc64b71684c4918e7d33b4
    if [ -f "$0" ] && [ -f "$(dirname "$0")/dist/$asset" ]; then
        cp "$(dirname "$0")/dist/$asset" "$tmp/$asset"
    else
        /usr/bin/curl --proto '=https' --tlsv1.2 -fLsS "https://github.com/lolabradora/paneparcel/releases/download/v0.3.0-beta.1/$asset" -o "$tmp/$asset"
    fi
    (cd "$tmp" && echo "$digest  $asset" | /usr/bin/shasum -a 256 -c -)
    /usr/bin/tar xzf "$tmp/$asset" -C "$tmp"
    "$tmp/paneparcel" register install --extension-id hjaimaioehmmfbfclcmmphhenealomfp "$@"
}
install_paneparcel "$@"
