import io
import json
from pathlib import Path
import shlex
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.request = {
            "session": "session:00000000-0000-0000-0000-000000000001",
            "block": "block:00000000-0000-0000-0000-000000000002",
            "page": "https://example.org/page?q=one#two",
            "notes": [{"comment": "Move the café sign here", "text": "", "selector": "button", "height": 900, "width": 1280}],
        }

    def test_paste_preserves_unicode_and_cannot_type_terminal_controls(self):
        special = "It's\n\x1b[201~\r\x03 `echo` $(echo) ! '; foo; # 🌍"
        self.request["notes"][0]["comment"] = special
        message = bridge.batch_message(self.request)
        self.assertTrue(all(ch.isprintable() for ch in message))
        # All page-supplied data constitutes a single quoted shell argument.
        args = shlex.split(message)
        self.assertEqual(args[:-1], ["Web", "annotations", "from", "PaneParcel:"])
        batch = json.loads(args[-1])
        self.assertEqual(batch["Source page"], self.request["page"])
        self.assertEqual(batch["notes"][0]["User note"], special)
        self.assertEqual(batch["notes"][0]["Selected element"], {"selector": "button", "text": "", "viewport": "1280x900"})

    def test_notes_state_their_kind_and_default_to_change(self):
        self.request["notes"].append({**self.request["notes"][0], "kind": "question"})
        batch = json.loads(shlex.split(bridge.batch_message(self.request))[-1])
        self.assertEqual([note["kind"] for note in batch["notes"]], ["change", "question"])
        self.request["notes"][0]["kind"] = "praise"
        with self.assertRaises(bridge.BridgeError):
            bridge.batch_message(self.request)

    def test_incomplete_and_oversize_frames_are_rejected_before_parsing(self):
        for data in (b"", struct.pack("=I", 300) + b"{}", struct.pack("=I", bridge.MAX_FRAME + 1)):
            with self.subTest(data=data), self.assertRaises(bridge.BridgeError):
                bridge.receive(io.BytesIO(data))
        self.assertEqual(bridge.receive(io.BytesIO(struct.pack("=I", 2) + b"{}")), {})

    def test_send_requires_full_ids_before_rex_invocation(self):
        self.request["block"] = "focused"
        with patch.object(bridge, "rex") as rex, self.assertRaises(bridge.BridgeError):
            bridge.deliver(self.request)
        rex.assert_not_called()

    def test_changed_process_after_paste_never_receives_enter(self):
        with tempfile.TemporaryDirectory() as home, patch.object(Path, "home", return_value=Path(home)), \
                patch.object(bridge, "agent_process", side_effect=[bridge.Agent("codex", pid, home) for pid in (11, 12)]), \
                patch.object(bridge, "rex") as rex:
            with self.assertRaisesRegex(bridge.BridgeError, "uncertain"):
                bridge.deliver(self.request)
        rex.assert_called_once()
        self.assertEqual(rex.call_args.args, ("api", "call", "block.event", "-"))
        event = json.loads(rex.call_args.kwargs["data"])
        self.assertEqual(event["block_id"], self.request["block"])
        self.assertEqual(event["session_id"], self.request["session"])

    def test_foreground_only_agent_detection(self):
        shell = {"foreground": {"name": "zsh", "pid": 1}, "ancestors": [{"name": "codex"}]}
        claude = {"foreground": {"name": "node", "script": "/npm/@anthropic-ai/claude-code/cli.js", "pid": 2, "cwd": "/"}}
        with patch.object(bridge, "AGENTS", {"codex", "claude"}, create=True), \
                patch.object(bridge, "rex", side_effect=[json.dumps(shell), json.dumps(claude)]):
            self.assertIsNone(bridge.agent_process("s", "b"))
            self.assertEqual(bridge.agent_process("s", "b"), bridge.Agent("claude", 2, "/"))

    def test_project_changed_before_send(self):
        with tempfile.TemporaryDirectory() as home, patch.object(Path, "home", return_value=Path(home)), \
                patch.object(bridge, "agent_process", return_value=bridge.Agent("codex", 11, "/")), \
                patch.object(bridge, "rex") as rex:
            with self.assertRaisesRegex(bridge.BridgeError, "different project"):
                bridge.deliver(dict(self.request, project=home))
        rex.assert_not_called()

    def test_native_folder_selection_and_cancellation(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "my project"
            folder.mkdir()
            alias = Path(tmp) / "alias"
            alias.symlink_to(folder)
            with patch("subprocess.run", side_effect=[
                subprocess.CompletedProcess([], 0, stdout=f"{alias}/\n"),
                subprocess.CompletedProcess([], 0, stdout="\n"),
            ]):
                self.assertEqual(bridge.choose_folder(), str(folder.resolve()))
                self.assertIsNone(bridge.choose_folder())
            with self.assertRaisesRegex(bridge.BridgeError, "existing project"):
                bridge.project_folder("relative")

    def test_start_passes_one_prompt_directly_and_uses_live_project(self):
        session, block = self.request["session"], self.request["block"]
        creation = {"session_id": session, "initial_windows": [{"block_ids": [block]}]}
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)), patch("time.sleep"), \
                patch("shutil.which", return_value="/bin/codex"), \
                patch.object(bridge, "rex", side_effect=['{"sessions":[]}', json.dumps(creation)]) as rex:
            project = str(Path(tmp).resolve())
            running = bridge.Agent("codex", 42, project)
            with patch.object(bridge, "agent_process", side_effect=[None, running]):
                target = bridge.start(dict(self.request, project=tmp, agent="codex"))
        args = rex.call_args_list[1].args
        self.assertEqual(args[args.index("--cwd") + 1], project)
        self.assertIn("--shell=none", args)
        self.assertEqual(args[-2:], ("/bin/codex", bridge.batch_message(self.request)))
        self.assertEqual(rex.call_args_list[1].kwargs, {"autostart": True})
        self.assertEqual(args[args.index("--") - 1], Path(project).name + " · Codex")
        self.assertEqual(target, {"session": session, "block": block, "project": project,
                                  "label": Path(project).name + " · Codex / Tab 1 (Notes) / Pane 1"})

    def test_start_failure_keeps_delivery_uncertain_if_process_exited(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)), patch("time.sleep"), \
                patch("shutil.which", return_value="/bin/claude"), \
                patch.object(bridge, "rex", return_value='{"session_id":"s","initial_windows":[{"block_ids":["b"]}]}'), \
                patch.object(bridge, "agent_process", return_value=None):
            with self.assertRaisesRegex(bridge.BridgeError, "Check Rex before starting another"):
                bridge.start(dict(self.request, project=tmp, agent="claude"))

    def test_new_conversation_rejects_missing_cli_before_creating_session(self):
        with tempfile.TemporaryDirectory() as tmp, patch("shutil.which", return_value=None), \
                patch.object(bridge, "rex") as rex:
            with self.assertRaisesRegex(bridge.BridgeError, "Install Claude Code"):
                bridge.start(dict(self.request, project=tmp, agent="claude"))
        rex.assert_not_called()

    def test_numbered_labels_follow_the_project_and_agent(self):
        sessions = [{"label": label} for label in ("a project · Codex", "a project · Codex (2)")]
        self.assertEqual(bridge.new_session_label("/work/a project", "codex", sessions), "a project · Codex (3)")
        self.assertEqual(bridge.new_session_label("/work/a project", "claude", sessions), "a project · Claude Code")
        self.assertFalse(bridge.new_session_label("/work/-test", "codex", []).startswith("-"))

    def test_no_server_returns_empty_picker(self):
        with patch.object(bridge, "rex", side_effect=bridge.NoServer()):
            self.assertEqual(bridge.destinations(), [])

    def native_reply(self, request):
        data = json.dumps(request).encode("utf-8")
        stdin = SimpleNamespace(buffer=io.BytesIO(struct.pack("=I", len(data)) + data))
        stdout = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(bridge.sys, "stdin", stdin), patch.object(bridge.sys, "stdout", stdout):
            bridge.main()
        framed = stdout.buffer.getvalue()
        self.assertEqual(struct.unpack("=I", framed[:4])[0], len(framed) - 4)
        return json.loads(framed[4:].decode("utf-8"))

    def test_send_failures_state_whether_the_paste_may_have_landed(self):
        send = {**self.request, "op": "send"}
        with tempfile.TemporaryDirectory() as home, patch.object(Path, "home", return_value=Path(home)), \
                patch.object(bridge, "agent_process", side_effect=[bridge.Agent("codex", pid, home) for pid in (11, 12)]), \
                patch.object(bridge, "rex"):
            reply = self.native_reply(send)
        self.assertEqual((reply["ok"], reply["uncertain"]), (False, True))
        with tempfile.TemporaryDirectory() as home, patch.object(Path, "home", return_value=Path(home)), \
                patch.object(bridge, "agent_process", return_value=None), patch.object(bridge, "rex") as rex:
            reply = self.native_reply(send)
        self.assertEqual((reply["ok"], reply["uncertain"]), (False, False))
        rex.assert_not_called()
        with patch.object(bridge, "rex") as rex:
            reply = self.native_reply({**send, "block": "focused"})
        self.assertEqual((reply["ok"], reply["uncertain"]), (False, False))
        rex.assert_not_called()
        # Start keeps the legacy shape: no flag, read as uncertain.
        self.assertNotIn("uncertain", self.native_reply({**self.request, "op": "start", "agent": "other"}))

    def test_capabilities_request_is_cleanly_rejected(self):
        # The extension reads a failed capabilities request as "no screenshots, payload 1".
        self.assertEqual(self.native_reply({"op": "capabilities"}), {"ok": False, "error": "Unknown operation."})

    def test_newer_note_shapes_are_rejected_with_a_recovery_and_never_reach_rex(self):
        base = self.request["notes"][0]
        selection = {key: base[key] for key in ("comment", "height", "width")}
        newer = {
            "area": {**selection, "scope": "area", "rect": {"x": 1, "y": 2, "width": 30, "height": 40}},
            "group": {**selection, "scope": "group", "elements": [{"selector": "a", "text": ""}, {"selector": "b", "text": ""}]},
            "reference": {**base, "reference": "data:image/jpeg;base64,/9j/4A=="},
            "unknown scope": {**base, "scope": "page"},
        }
        for name, note in newer.items():
            with self.subTest(name), patch.object(bridge, "rex") as rex:
                reply = self.native_reply({**self.request, "op": "send", "notes": [note]})
                self.assertEqual(reply["ok"], False)
                self.assertRegex(reply["error"], "too old for area, group or reference notes.*Copy for agent")
                self.assertIs(reply["uncertain"], False)
                rex.assert_not_called()
        explicit = {**base, "scope": "element", "reference": None}
        bridge.batch_message({**self.request, "notes": [explicit]})


if __name__ == "__main__":
    unittest.main()
