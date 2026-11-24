"""Install the PaneParcel native host for the current macOS Chrome user."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile

NAME = "com.micovi.paneparcel"
DEFAULT_ID = "nbodoigokndfjagdocbaobppgepiflpf"


def replace(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        try:
            temp.write(content)
            temp.flush()
            os.chmod(temp.name, mode)
            os.replace(temp.name, path)
        finally:
            Path(temp.name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extension_id", nargs="?", default=DEFAULT_ID)
    parser.add_argument("--agent", action="append", default=[], metavar="NAME",
                        help="also allow this foreground CLI executable (repeatable)")
    parser.add_argument("--uninstall", action="store_true", help="remove the host registration and program")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This installer currently supports macOS.")
    support = Path.home() / "Library/Application Support"
    installed = support / "PaneParcel"
    manifest = support / "Google/Chrome/NativeMessagingHosts" / (NAME + ".json")
    bridge = installed / "bridge.py"
    launcher = installed / "launch"
    if args.uninstall:
        for path in (manifest, launcher, bridge):
            path.unlink(missing_ok=True)
        if installed.is_dir() and not any(installed.iterdir()):
            installed.rmdir()
        print("Removed the PaneParcel native host.")
        return
    if not re.fullmatch("[a-p]{32}", args.extension_id):
        parser.error("Expected a 32-character Chrome extension ID (letters a–p).")
    if any(not re.fullmatch(r"[\w.+-]{1,80}", name) for name in args.agent):
        parser.error("Each --agent must be an executable name without spaces or a path.")
    rex = shutil.which("rex")
    if not rex:
        parser.error("Install Rex and make rex available on PATH, then run this command again.")
    # GUI launches don't inherit the user's shell PATH. Keep Rex's stable
    # Current symlink and the Python interpreter used for installation.
    command = [sys.executable, "-I", str(bridge), os.path.abspath(rex), *args.agent]
    replace(bridge, Path(__file__).with_name("bridge.py").read_bytes(), 0o600)
    # New conversations need the same CLI and runtime lookup paths as the
    # installing terminal. Skip relative entries when starting in a new cwd.
    cli_path = os.pathsep.join(entry for entry in os.get_exec_path() if os.path.isabs(entry))
    launcher_text = f"#!/bin/sh\nexport PATH={shlex.quote(cli_path)}\nexec {shlex.join(command)}\n"
    replace(launcher, launcher_text.encode(), 0o700)
    registration = {
        "name": NAME, "description": "Send browser annotations to Rex",
        "path": str(launcher), "type": "stdio",
        "allowed_origins": [f"chrome-extension://{args.extension_id}/"],
    }
    replace(manifest, (json.dumps(registration, indent=2) + "\n").encode(), 0o600)
    print(f"Registered {NAME} for extension {args.extension_id}.")


if __name__ == "__main__":
    main()
