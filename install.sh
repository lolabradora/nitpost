#!/bin/sh
# Bootstrap for the version-matched Apple Silicon macOS release.
set -eu
install_nitpost() {
    [ "$(uname -s)" = Darwin ] || { echo "Nitpost requires macOS and Google Chrome." >&2; return 1; }
    [ "$(uname -m)" = arm64 ] || [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || {
        echo "Nitpost requires an Apple Silicon Mac." >&2; return 1;
    }
    skill=
    if [ "${1:-}" = --skill ]; then
        case "${2:-}" in
            codex|claude) skill=$2; shift 2 ;;
            *) echo 'Use --skill codex or --skill claude.' >&2; return 1 ;;
        esac
    fi
    umask 077
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/nitpost.XXXXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    asset=nitpost-macos-arm64.tar.gz
    digest=c814b1c257ee79f5581a81d8c2e591a78c7cfd33bf6d6d23e05a5553788f6133
    if [ -f "$0" ] && [ -f "$(dirname "$0")/dist/$asset" ]; then
        cp "$(dirname "$0")/dist/$asset" "$tmp/$asset"
    else
        /usr/bin/curl --proto '=https' --tlsv1.2 -fLsS "https://github.com/lolabradora/nitpost/releases/download/v0.3.0-beta.2/$asset" -o "$tmp/$asset"
    fi
    (cd "$tmp" && echo "$digest  $asset" | /usr/bin/shasum -a 256 -c -)
    /usr/bin/tar xzf "$tmp/$asset" -C "$tmp"
    "$tmp/nitpost" register install --extension-id hjaimaioehmmfbfclcmmphhenealomfp "$@"
    if [ -n "$skill" ]; then
        /bin/sh "$tmp/scripts/install-skill.sh" "$skill"
    fi
}
install_nitpost "$@"
