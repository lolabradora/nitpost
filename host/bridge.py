"""Chrome Native Messaging bridge for an explicitly selected Rex agent."""
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import time
from typing import NamedTuple
from urllib.parse import urlsplit

MAX_FRAME = 2 * 1024 * 1024
HEADER = struct.Struct("=I")
UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"


class BridgeError(Exception):
    pass


class NoServer(BridgeError):
    pass


class Uncertain(BridgeError):
    """The paste may already have reached the agent."""


class Agent(NamedTuple):
    name: str
    pid: int
    project: str


AGENT_TITLES = {"codex": "Codex", "claude": "Claude Code"}


def rex(*args, data=None, autostart=False):
    try:
        completed = subprocess.run(
            [REX, f"--autostart={str(autostart).lower()}", *args], input=data, capture_output=True,
            text=True, encoding="utf-8", timeout=15, check=True,
        )
    except subprocess.CalledProcessError as exc:
        if "no Rex server is running" in exc.stderr:
            raise NoServer("Rex is not running.") from exc
        raise BridgeError("Rex could not complete the request. Refresh the destinations.") from exc
    except OSError as exc:
        if exc.errno == errno.E2BIG:
            raise BridgeError("The batch is too long to start a new conversation. Send fewer notes.") from exc
        raise BridgeError("Could not run Rex. Check the local helper installation.") from exc
    except subprocess.TimeoutExpired as exc:
        raise BridgeError("Rex took too long to respond.") from exc
    return completed.stdout


def agent_process(session, block):
    result = json.loads(rex("block", "call", "-s", session, "-b", block, "process"))
    foreground = result.get("foreground") or {}
    names = [Path(foreground.get(key, "")).name for key in ("script", "invoked_path", "name", "argv0")]
    # Older npm installs can launch the agent as node with a generic cli.js.
    script = Path(foreground.get("script", ""))
    if "@anthropic-ai" in script.parts and "claude-code" in script.parts:
        names.append("claude")
    if "@openai" in script.parts and "codex" in script.parts:
        names.append("codex")
    agent = next((name for name in names if name in AGENTS), None)
    cwd = foreground.get("cwd", "")
    if not agent or not foreground.get("pid") or not os.path.isabs(cwd):
        return None
    return Agent(agent, foreground["pid"], os.path.realpath(cwd))


def target_info(session, block, agent, session_label, tab, pane):
    agent_name = AGENT_TITLES.get(agent.name, agent.name)
    heading = session_label if f" · {agent_name}" in session_label else f"{agent_name} · {session_label}"
    label = f"{heading} / {tab} / {pane}"
    return {"session": session, "block": block, "label": label, "project": agent.project}


def list_sessions(autostart=False):
    return json.loads(rex("ls", "--json", autostart=autostart)).get("sessions") or []


def destinations():
    targets = []
    try:
        sessions = list_sessions()
    except NoServer:
        return []
    labels = [s.get("label") for s in sessions]
    for session_no, session in enumerate(sessions, 1):
        session_id = session["session_id"]
        name = session.get("label") or "Session"
        if labels.count(name) > 1:
            name += f" (session {session_no})"
        try:
            windows = json.loads(rex("window", "ls", "-s", session_id, "--json"))["windows"]
        except BridgeError:
            continue  # A session can close during discovery.
        for tab_no, window in enumerate(windows or [], 1):
            tab = f"Tab {tab_no}"
            window_name = window.get("label") or ""
            if window_name and not re.fullmatch(r"Window [0-9a-fA-F]{8}", window_name):
                tab += f" ({window_name})"
            blocks = [block for layer in window.get("layers") or [] for block in layer.get("blocks") or []]
            for pane_no, block in enumerate(blocks, 1):
                if block["creator_name"] != "com.superlogical.terminal":
                    continue
                block_id = block["block_id"]
                try:
                    agent = agent_process(session_id, block_id)
                except BridgeError:
                    continue
                if agent:
                    pane = f"Pane {pane_no}"
                    if block.get("label") and block["label"] != "shell":
                        pane += f" ({block['label']})"
                    targets.append(target_info(session_id, block_id, agent, name, tab, pane))
    return targets


def project_folder(value):
    if not isinstance(value, str) or not os.path.isabs(value) or not os.path.isdir(value):
        raise BridgeError("Choose an existing project folder on this Mac.")
    return os.path.realpath(value)


def choose_folder():
    # A static Standard Additions dialog needs no Finder automation permission.
    script = """activate
try
    return POSIX path of (choose folder with prompt "Choose a project folder for Nitpost")
on error number -128
    return ""
end try"""
    try:
        choice = subprocess.run(["osascript", "-e", script], capture_output=True,
                                encoding="utf-8", check=True).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise BridgeError("The macOS folder picker could not open. Try again.") from exc
    path = choice[:-1] if choice.endswith("\n") else choice
    return project_folder(path) if path else None


def bounded_string(obj, key, limit, *, optional=False):
    value = obj.get(key)
    if not isinstance(value, str) or len(value) > limit or (not optional and not value.strip()):
        raise BridgeError(f"Invalid {key} in annotation batch.")
    return value


def batch_message(request):
    page = bounded_string(request, "page", 16384)
    url = urlsplit(page)
    web_page = url.scheme in {"http", "https"} and bool(url.hostname)
    local_file = url.scheme == "file" and not url.netloc and url.path.startswith("/")
    if not (web_page or local_file):
        raise BridgeError("Choose a web page or a local file.")
    notes = request.get("notes")
    if not isinstance(notes, list) or not 1 <= len(notes) <= 50:
        raise BridgeError("Send between 1 and 50 saved notes.")
    clean = []
    for note in notes:
        if not isinstance(note, dict):
            raise BridgeError("Invalid note.")
        # This host predates area, group and reference notes. Say so instead of
        # reporting a missing selector or delivering the note without its image.
        if note.get("scope", "element") != "element" or any(
                note.get(key) is not None for key in ("rect", "elements", "reference")):
            raise BridgeError("This Nitpost helper is too old for area, group or reference notes. "
                              "Update the helper or use Copy for agent.")
        item = {
            "User note": bounded_string(note, "comment", 2000),
            "Selected element": {
                "selector": bounded_string(note, "selector", 2048),
                "text": bounded_string(note, "text", 1000, optional=True),
            },
        }
        kind = note.get("kind", "change")
        if kind not in ("change", "question"):
            raise BridgeError("Invalid kind in annotation batch.")
        item["kind"] = kind
        for dim in ("width", "height"):
            if type(note.get(dim)) is not int or not 0 <= note[dim] <= 100000:
                raise BridgeError("Invalid viewport dimensions.")
        item["Selected element"]["viewport"] = f"{note['width']}x{note['height']}"
        clean.append(item)
    # A single quoted JSON argument keeps a departing agent from exposing shell
    # syntax or embedded terminal actions to its parent shell. Preserve Unicode.
    body = json.dumps({"Source page": page, "notes": clean}, ensure_ascii=False)
    body = re.sub(r"['!\x7f-\x9f\ud800-\udfff\u2028\u2029]", lambda m: "\\u%04x" % ord(m[0]), body)
    return "Web annotations from Nitpost: '" + body + "'"


def lock_file(name):
    directory = Path.home() / "Library/Caches/com.micovi.nitpost"
    directory.mkdir(parents=True, exist_ok=True)
    return (directory / name).open("a")


def deliver(request):
    session, block = request.get("session"), request.get("block")
    if not all(isinstance(value, str) and re.fullmatch(prefix + UUID, value)
               for prefix, value in (("session:", session), ("block:", block))):
        raise BridgeError("Choose a valid Rex destination.")
    message = batch_message(request)
    # sendNativeMessage starts a fresh process for each request. Serialize each
    # paste + Enter pair across tabs and Chrome profiles using the same host.
    with lock_file("delivery.lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BridgeError("Another batch is being delivered. Try again in a moment.")
        before = agent_process(session, block)
        if not before:
            raise BridgeError("The selected pane no longer has a supported agent in the foreground.")
        if "project" in request and project_folder(request["project"]) != before.project:
            raise BridgeError("This conversation now belongs to a different project. Refresh destinations.")
        event = {"session_id": session, "block_id": block, "event": {"type": "paste", "payload": {"text": message}}}
        try:
            rex("api", "call", "block.event", "-", data=json.dumps(event))
            if before != agent_process(session, block):
                raise BridgeError("The foreground process changed.")
            rex("send-key", "-s", session, "-b", block, "enter")
        except (BridgeError, ValueError) as exc:
            raise Uncertain("Delivery is uncertain. Check the selected Rex pane before sending again.") from exc


def new_session_label(project, agent, sessions):
    # Rex accepts labels up to 128 characters; leave room for the agent and suffix.
    folder = "".join(c if c.isprintable() else " " for c in Path(project).name).strip() or "Root"
    if folder.startswith("-"):
        folder = "./" + folder
    folder = folder.encode("utf-8")[:90].decode("utf-8", errors="ignore")
    base = f"{folder} · {AGENT_TITLES[agent]}"
    used = {session.get("label") for session in sessions}
    candidate = base
    number = 1
    while candidate in used:
        number += 1
        candidate = f"{base} ({number})"
    return candidate


def start(request):
    agent = request.get("agent")
    if not isinstance(agent, str) or agent not in AGENT_TITLES:
        raise BridgeError("Choose Codex or Claude Code.")
    project = project_folder(request.get("project"))
    prompt = batch_message(request)
    executable = shutil.which(agent)
    if not executable:
        raise BridgeError(f"Install {AGENT_TITLES[agent]} and rerun the Nitpost installer from your terminal.")
    try:
        # Two Chrome profiles can start a session simultaneously. Hold the name
        # reservation until Rex has registered the new session on its server.
        with lock_file("session-names.lock") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            label = new_session_label(project, agent, list_sessions(autostart=True))
            created = json.loads(rex("new", "--json", "--shell=none", "--cwd", project, "--window", "Notes",
                                     label, "--", "/usr/bin/env", "PATH=" + os.environ["PATH"],
                                     executable, prompt, autostart=True))
        session = created["session_id"]
        block = created["initial_windows"][0]["block_ids"][0]
        # A successful session.create only acknowledges a terminal. Confirm it
        # actually started the requested interactive process in the chosen cwd.
        for _ in range(10):
            time.sleep(0.25)
            running = agent_process(session, block)
            if running and running.name == agent and running.project == project:
                return target_info(session, block, running, label, "Tab 1 (Notes)", "Pane 1")
    except (BridgeError, ValueError, IndexError, KeyError) as exc:
        if isinstance(exc.__cause__, OSError) and exc.__cause__.errno == errno.E2BIG:
            raise
        raise BridgeError("Could not confirm the new conversation. Check Rex before starting another.") from exc
    raise BridgeError(f"{AGENT_TITLES[agent]} did not stay open in the project folder. Check Rex before starting another.")


def receive(stream):
    header = stream.read(HEADER.size)
    if len(header) != HEADER.size:
        raise BridgeError("Incomplete native message header.")
    size, = HEADER.unpack(header)
    if not 0 < size <= MAX_FRAME:
        raise BridgeError("Native message size exceeds the allowed range.")
    data = stream.read(size)
    if len(data) != size:
        raise BridgeError("Incomplete native message.")
    return json.loads(data.decode("utf-8"))


def main():
    try:
        request = receive(sys.stdin.buffer)
        if not isinstance(request, dict):
            raise BridgeError("Invalid native request.")
        if request.get("op") == "targets":
            response = {"ok": True, "targets": destinations()}
        elif request.get("op") == "chooseFolder":
            response = {"ok": True, "project": choose_folder()}
        elif request.get("op") == "start":
            response = {"ok": True, "target": start(request)}
        elif request.get("op") == "send":
            deliver(request)
            response = {"ok": True}
        else:
            raise BridgeError("Unknown operation.")
    except BridgeError as exc:
        response = {"ok": False, "error": str(exc)}
        # A send rejected before the paste is definite. Start and unexpected errors stay
        # unflagged, which the extension reads as uncertain.
        if request.get("op") == "send":
            response["uncertain"] = isinstance(exc, Uncertain)
    except (ValueError, KeyError, OSError, TypeError, RecursionError, subprocess.SubprocessError):
        response = {"ok": False, "error": "Invalid data or unavailable local bridge. Refresh destinations and try again."}
    data = json.dumps(response).encode("utf-8")
    sys.stdout.buffer.write(HEADER.pack(len(data)) + data)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    REX = sys.argv[1]
    AGENTS = {"codex", "claude"}
    main()
