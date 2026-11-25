#!/bin/sh
# Bootstrap for the version-matched Apple Silicon macOS release.
set -eu
install_paneparcel() {
    [ "$(uname -s)" = Darwin ] || { echo "PaneParcel requires macOS and Google Chrome." >&2; return 1; }
    [ "$(uname -m)" = arm64 ] || [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || {
        echo "PaneParcel requires an Apple Silicon Mac." >&2; return 1;
    }
    skill=
    if [ "${1:-}" = --skill ]; then
        case "${2:-}" in
            codex|claude) skill=$2; shift 2 ;;
            *) echo 'Use --skill codex or --skill claude.' >&2; return 1 ;;
        esac
    fi
    umask 077
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/paneparcel.XXXXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    asset=paneparcel-macos-arm64.tar.gz
    digest=9b9f9254f008f8040bcead5a32bde91b4690d6354553814079eb2cc6aa964819
    if [ -f "$0" ] && [ -f "$(dirname "$0")/dist/$asset" ]; then
        cp "$(dirname "$0")/dist/$asset" "$tmp/$asset"
    else
        /usr/bin/curl --proto '=https' --tlsv1.2 -fLsS "https://github.com/lolabradora/paneparcel/releases/download/v0.3.0-beta.2/$asset" -o "$tmp/$asset"
    fi
    (cd "$tmp" && echo "$digest  $asset" | /usr/bin/shasum -a 256 -c -)
    /usr/bin/tar xzf "$tmp/$asset" -C "$tmp"
    "$tmp/paneparcel" register install --extension-id hjaimaioehmmfbfclcmmphhenealomfp "$@"
    if [ -n "$skill" ]; then
        /bin/sh "$tmp/scripts/install-skill.sh" "$skill"
    fi
}
install_paneparcel "$@"
