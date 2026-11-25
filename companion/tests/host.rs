//! Drives the built host over native-messaging framing against disposable destinations.
//!
//! Every host process started here gets a temporary HOME, agent directories inside it and a
//! PATH of system directories plus fakes written by the test, so it can never discover or
//! deliver to a real Claude Code, Codex, tmux or Rex session on this machine.
//! The tmux route is not driven here: it needs a live `codex` process holding a thread lock.
//! Its decision points are unit-tested in `src/agents/terminal.rs`.

use serde_json::{json, Value};
use std::{
    fs,
    io::{ErrorKind, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tungstenite::Message;

const SYSTEM_PATH: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const THREAD: &str = "11111111-1111-4111-8111-111111111111";
const BUSY_THREAD: &str = "22222222-2222-4222-8222-222222222222";
const CLAUDE_SESSION: &str = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION: &str = "44444444-4444-4444-8444-444444444444";
const REX_SESSION: &str = "session:55555555-5555-4555-8555-555555555555";
const REX_BLOCK: &str = "block:66666666-6666-4666-8666-666666666666";
// "/9j/4A==" and "/9j/2w==" are JPEG signatures with different fourth bytes.
const SHOT: &str = "data:image/jpeg;base64,/9j/4A==";
const REFERENCE: &str = "data:image/jpeg;base64,/9j/2w==";

struct Sandbox {
    dir: tempfile::TempDir,
}
impl Sandbox {
    fn new() -> Self {
        for dir in SYSTEM_PATH {
            for agent in ["claude", "codex", "tmux", "rex"] {
                assert!(
                    !Path::new(dir).join(agent).exists(),
                    "{dir}/{agent} is a real agent on the test PATH"
                );
            }
        }
        let dir = tempfile::tempdir().unwrap();
        for name in ["home", "bin", "codex", "claude/sessions"] {
            fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        Self { dir }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
    fn shots(&self) -> PathBuf {
        self.path("home/Library/Caches/com.micovi.paneparcel/shots")
    }
    fn host(&self) -> Command {
        let path = format!("{}:{}", self.path("bin").display(), SYSTEM_PATH.join(":"));
        let mut host = Command::new(env!("CARGO_BIN_EXE_paneparcel"));
        host.env_clear()
            .env("HOME", self.path("home"))
            .env("PATH", path)
            .env("CLAUDE_CONFIG_DIR", self.path("claude"))
            .env("CODEX_HOME", self.path("codex"))
            .env("PANEPARCEL_CODEX_SOCKET", self.path("codex.sock"));
        host
    }
    fn request(&self, body: Value) -> Value {
        let body = serde_json::to_vec(&body).unwrap();
        let mut host = self
            .host()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = host.stdin.take().unwrap();
        stdin.write_all(&(body.len() as u32).to_ne_bytes()).unwrap();
        stdin.write_all(&body).unwrap();
        drop(stdin);
        let output = host.wait_with_output().unwrap();
        assert!(output.status.success());
        let (header, reply) = output.stdout.split_at(4);
        assert_eq!(
            u32::from_ne_bytes(header.try_into().unwrap()) as usize,
            reply.len()
        );
        serde_json::from_slice(reply).unwrap()
    }
    fn send(&self, target: &Value) -> Value {
        let mut request = json!({"op":"send","page":"https://example.test/pricing?plan=pro",
            "notes":notes()});
        for key in ["session", "block", "project", "identity"] {
            if !target[key].is_null() {
                request[key] = target[key].clone();
            }
        }
        self.request(request)
    }
    fn executable(&self, name: &str, script: &str) {
        let path = self.path("bin").join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn notes() -> Value {
    json!([
        {"kind":"change","comment":"Make it larger","width":1280,"height":800,
            "selector":"main > h1","text":"Pricing","image":SHOT},
        {"scope":"area","kind":"change","comment":"Reduce this gap","width":1280,"height":800,
            "rect":{"x":40,"y":2210,"width":600,"height":96},"image":SHOT,"reference":REFERENCE},
        {"scope":"group","kind":"question","comment":"Why do these differ?","width":1280,
            "height":800,"elements":[{"selector":"#plan-a","text":"Basic"},
            {"selector":"#plan-b","text":"Pro"}]}
    ])
}
// Recovers the batch from the single shell-quoted argument an agent receives.
fn batch(message: &str) -> Value {
    let (intro, body) = message.split_once('\'').unwrap();
    assert_eq!(intro, "Web annotations from PaneParcel: ");
    let body = body.strip_suffix('\'').unwrap();
    assert!(!body.contains('\''));
    serde_json::from_str(body).unwrap()
}
fn assert_batch_content(sandbox: &Sandbox, message: &str) {
    let batch = batch(message);
    assert_eq!(
        batch["Source page"],
        "https://example.test/pricing?plan=pro"
    );
    let notes = batch["notes"].as_array().unwrap();
    assert_eq!(notes[0]["Selected element"]["selector"], "main > h1");
    let area = &notes[1]["Selected area"];
    assert_eq!(
        area["rect"],
        json!({"x":40,"y":2210,"width":600,"height":96})
    );
    assert!(!notes[1].to_string().contains("selector"));
    assert_eq!(
        notes[2]["Selected elements"]["elements"],
        json!([{"selector":"#plan-a","text":"Basic"},{"selector":"#plan-b","text":"Pro"}])
    );
    let shot = Path::new(area["screenshot"].as_str().unwrap());
    let reference = Path::new(notes[1]["Reference image"].as_str().unwrap());
    assert_eq!(fs::read(shot).unwrap(), [0xff, 0xd8, 0xff, 0xe0]);
    assert_eq!(fs::read(reference).unwrap(), [0xff, 0xd8, 0xff, 0xdb]);
    for image in [shot, reference] {
        assert_eq!(image.parent(), Some(sandbox.shots().as_path()));
        assert_eq!(
            image.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(notes[0].get("Reference image").is_none());
    assert!(batch["kinds"].as_str().unwrap().contains("Reference image"));
}
fn is_plain_failure(reply: &Value) -> bool {
    reply["ok"] == false && reply["error"].is_string() && reply["uncertain"] == false
}
fn is_uncertain_failure(reply: &Value) -> bool {
    reply["ok"] == false && reply["uncertain"] == true
}

#[derive(Clone, Copy)]
enum Turn {
    Accept,
    Decline,
    Silent,
}
// A stand-in for the Codex owner server. Returns the turns it was asked to start.
fn serve_codex(socket: &Path, turn: Turn) -> Arc<Mutex<Vec<Value>>> {
    let listener = UnixListener::bind(socket).unwrap();
    let turns = Arc::new(Mutex::new(vec![]));
    let seen = turns.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut socket) = tungstenite::accept(stream.unwrap()) else {
                continue;
            };
            while let Ok(Message::Text(text)) = socket.read() {
                let request: Value = serde_json::from_str(&text).unwrap();
                let reply = match request["method"].as_str().unwrap() {
                    "initialized" => continue,
                    "initialize" => json!({"result":{}}),
                    "thread/loaded/list" => {
                        json!({"result":{"data":[THREAD, BUSY_THREAD],"nextCursor":null}})
                    }
                    "thread/read" => {
                        let id = &request["params"]["threadId"];
                        let status = if id == THREAD { "idle" } else { "active" };
                        json!({"result":{"thread":{"id":id,"source":"cli","parentThreadId":null,
                            "status":{"type":status},"cwd":"/work/site","name":"Landing page"}}})
                    }
                    "turn/start" => {
                        seen.lock().unwrap().push(request["params"].clone());
                        match turn {
                            Turn::Accept => json!({"result":{"turn":{"id":"turn-1"}}}),
                            Turn::Decline => json!({"error":{"code":-32600,"message":"busy"}}),
                            // Keep the connection open and say nothing until the host gives up.
                            Turn::Silent => continue,
                        }
                    }
                    method => panic!("unexpected Codex request {method}"),
                };
                let mut reply = reply;
                reply["id"] = request["id"].clone();
                // The host may already have left.
                let _ = socket.send(Message::text(reply.to_string()));
            }
        }
    });
    turns
}
fn codex_target(sandbox: &Sandbox) -> Value {
    let reply = sandbox.request(json!({"op":"targets"}));
    let targets = reply["targets"].as_array().unwrap();
    targets
        .iter()
        .find(|t| t["session"] == "codex-server")
        .unwrap()
        .clone()
}
// A stand-in for a Claude Code session: its peer inbox is a socket this process owns, so the
// host's peer-PID check passes, and a fake `claude` lists it.
fn open_claude_inbox(sandbox: &Sandbox) -> UnixListener {
    let pid = std::process::id();
    let socket = sandbox.path("inbox.sock");
    let inbox = UnixListener::bind(&socket).unwrap();
    let record = json!({"sessionId":CLAUDE_SESSION,"pid":pid,"cwd":"/work/site",
        "messagingSocketPath":socket});
    fs::write(
        sandbox.path(&format!("claude/sessions/{pid}.json")),
        record.to_string(),
    )
    .unwrap();
    let listing = json!([
        {"kind":"interactive","sessionId":CLAUDE_SESSION,"pid":pid,"cwd":"/work/site",
            "name":"site"},
        {"kind":"interactive","sessionId":OTHER_SESSION,"pid":2_000_000_000u32,
            "cwd":"/work/other","name":"no inbox"}
    ]);
    fs::write(sandbox.path("agents.json"), listing.to_string()).unwrap();
    sandbox.executable(
        "claude",
        &format!(
            "#!/bin/sh\n[ \"$1 $2\" = 'agents --json' ] || exit 64\nexec /bin/cat '{}'\n",
            sandbox.path("agents.json").display()
        ),
    );
    inbox
}
// Everything posted to the inbox so far, one JSON frame per line.
fn inbox_frames(inbox: &UnixListener) -> Vec<Value> {
    inbox.set_nonblocking(true).unwrap();
    let mut frames = vec![];
    loop {
        let stream: UnixStream = match inbox.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock => return frames,
            Err(e) => panic!("{e}"),
        };
        // The host has exited, so this read ends at the frame it left behind.
        stream.set_nonblocking(false).unwrap();
        let mut text = String::new();
        (&stream).read_to_string(&mut text).unwrap();
        for line in text.lines() {
            frames.push(serde_json::from_str(line).unwrap());
        }
    }
}

#[test]
fn capabilities_announce_the_second_payload_version() {
    let sandbox = Sandbox::new();
    assert_eq!(
        sandbox.request(json!({"op":"capabilities"})),
        json!({"ok":true,"shots":true,"payload":2})
    );
    // Only send and start deliver, so other failures carry no certainty flag.
    let invalid = sandbox.request(json!({"op":"invalid"}));
    assert_eq!(invalid["ok"], false);
    assert!(invalid.get("uncertain").is_none());
}

#[test]
fn an_empty_machine_explains_every_route() {
    let sandbox = Sandbox::new();
    let reply = sandbox.request(json!({"op":"targets"}));
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["targets"], json!([]));
    assert_eq!(reply["starts"], json!([]));
    let checks = reply["checks"].as_array().unwrap();
    let routes: Vec<_> = checks
        .iter()
        .map(|c| c["route"].as_str().unwrap())
        .collect();
    assert_eq!(routes, ["claude", "codex", "tmux", "rex"]);
    for check in checks {
        assert_eq!(check["found"], 0, "{check}");
        assert_eq!(check["eligible"], 0, "{check}");
        assert!(check["detail"].as_str().unwrap().len() > 20, "{check}");
    }
    assert!(checks[0]["detail"]
        .as_str()
        .unwrap()
        .contains("not on the helper's PATH"));
    assert!(checks[3]["detail"]
        .as_str()
        .unwrap()
        .contains("not on the helper's PATH"));
    // Nothing can be started without Rex, and nothing was launched to find that out.
    let start = sandbox.request(
        json!({"op":"start","agent":"codex","project":sandbox.path("home"),
        "page":"https://example.test/","notes":notes()}),
    );
    assert!(is_plain_failure(&start), "{start}");
    // A batch that fails validation is a definite failure too.
    let invalid = sandbox.request(json!({"op":"send","page":"https://example.test/","notes":[]}));
    assert!(is_plain_failure(&invalid), "{invalid}");
    assert!(!sandbox.shots().exists());
}

#[test]
fn codex_and_claude_destinations_are_listed_explained_and_delivered_to() {
    let sandbox = Sandbox::new();
    let turns = serve_codex(&sandbox.path("codex.sock"), Turn::Accept);
    let inbox = open_claude_inbox(&sandbox);

    let listed = sandbox.request(json!({"op":"targets"}));
    assert_eq!(listed["ok"], true);
    let targets = listed["targets"].as_array().unwrap();
    let claude = json!({"session":"claude-inbox","project":"/work/site",
        "block":format!("claude-inbox:{CLAUDE_SESSION}:{}", std::process::id()),
        "label":"Claude Code · site · 33333333 · peer inbox"});
    let codex = json!({"session":"codex-server","project":"/work/site",
        "block":format!("codex-server:{THREAD}"),
        "label":"Codex · Landing page · 11111111 · live server"});
    assert_eq!(targets, &[claude.clone(), codex.clone()]);
    let checks = &listed["checks"];
    assert_eq!(
        checks[0],
        json!({"route":"claude","found":2,"eligible":1,
            "detail":"1 Claude Code session can receive notes."})
    );
    assert_eq!(
        checks[1],
        json!({"route":"codex","found":2,"eligible":1,
            "detail":"1 Codex thread can receive notes."})
    );
    assert_eq!(checks[2]["route"], "tmux");
    assert_eq!(checks[3]["route"], "rex");
    let explained = checks.to_string();
    for private in [
        sandbox.dir.path().to_str().unwrap().to_owned(),
        ".sock".to_owned(),
        std::process::id().to_string(),
        "tty".to_owned(),
    ] {
        assert!(!explained.contains(&private), "checks leak {private}");
    }
    assert!(inbox_frames(&inbox).is_empty());
    assert!(turns.lock().unwrap().is_empty());

    let sent = sandbox.send(&codex);
    assert_eq!(
        sent,
        json!({"ok":true,"receipt":"confirmed",
            "notice":"Codex accepted the turn in the selected thread."})
    );
    {
        let turns = turns.lock().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["threadId"], THREAD);
        assert_eq!(turns[0]["input"][0]["type"], "text");
        assert_batch_content(&sandbox, turns[0]["input"][0]["text"].as_str().unwrap());
    }

    let sent = sandbox.send(&claude);
    assert_eq!(sent["ok"], true);
    assert_eq!(sent["receipt"], "unconfirmed");
    let notice = sent["notice"].as_str().unwrap();
    assert!(notice.contains("no receipt") && !notice.contains("remove"));
    assert!(sent.get("keepNotes").is_none());
    let frames = inbox_frames(&inbox);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["type"], "user");
    assert_eq!(frames[0]["from"], "PaneParcel");
    assert_eq!(frames[0]["message"]["role"], "user");
    assert_batch_content(&sandbox, frames[0]["message"]["content"].as_str().unwrap());

    // A selection that no longer matches a live destination delivers nowhere.
    let mut moved = codex.clone();
    moved["project"] = json!("/work/elsewhere");
    assert!(is_plain_failure(&sandbox.send(&moved)));
    let mut other = claude.clone();
    other["block"] = json!(format!("claude-inbox:{OTHER_SESSION}:2000000000"));
    assert!(is_plain_failure(&sandbox.send(&other)));

    // Both destinations close between listing and sending. Nothing more is written for them.
    let written = fs::read_dir(sandbox.shots()).unwrap().count();
    assert_eq!(written, 6);
    drop(inbox);
    let closed = sandbox.send(&claude);
    assert!(is_plain_failure(&closed), "{closed}");
    assert!(closed["error"]
        .as_str()
        .unwrap()
        .contains("Refresh destinations"));
    fs::remove_file(sandbox.path("inbox.sock")).unwrap();
    assert!(is_plain_failure(&sandbox.send(&claude)));
    fs::remove_file(sandbox.path("codex.sock")).unwrap();
    let closed = sandbox.send(&codex);
    assert!(is_plain_failure(&closed), "{closed}");
    assert!(closed["error"]
        .as_str()
        .unwrap()
        .contains("Refresh destinations"));
    assert_eq!(turns.lock().unwrap().len(), 1);
    assert_eq!(fs::read_dir(sandbox.shots()).unwrap().count(), written);

    let after = sandbox.request(json!({"op":"targets"}));
    assert_eq!(after["targets"], json!([]));
    assert_eq!(after["checks"][0]["found"], 2);
    assert_eq!(after["checks"][0]["eligible"], 0);
    assert!(after["checks"][0]["detail"]
        .as_str()
        .unwrap()
        .contains("none has a peer inbox"));
}

#[test]
fn a_codex_server_that_goes_silent_mid_turn_is_an_uncertain_delivery() {
    let sandbox = Sandbox::new();
    let turns = serve_codex(&sandbox.path("codex.sock"), Turn::Silent);
    let reply = sandbox.send(&codex_target(&sandbox));
    assert!(is_uncertain_failure(&reply), "{reply}");
    assert!(reply["error"]
        .as_str()
        .unwrap()
        .starts_with("Delivery is uncertain"));
    // The request did reach the server, which is why the helper cannot call it undelivered.
    assert_eq!(turns.lock().unwrap().len(), 1);
}

#[test]
fn a_codex_server_that_declines_the_turn_is_a_plain_failure() {
    let sandbox = Sandbox::new();
    let turns = serve_codex(&sandbox.path("codex.sock"), Turn::Decline);
    let reply = sandbox.send(&codex_target(&sandbox));
    assert!(is_plain_failure(&reply), "{reply}");
    assert!(reply["error"]
        .as_str()
        .unwrap()
        .contains("nothing was delivered"));
    assert_eq!(turns.lock().unwrap().len(), 1);
}

// A stand-in for the Rex CLI. Files in its state directory script each answer and failure,
// and record what the host asked it to paste, submit or launch.
fn install_fake_rex(sandbox: &Sandbox) -> (PathBuf, String) {
    let state = sandbox.path("rex");
    let project = sandbox.path("project");
    fs::create_dir_all(&state).unwrap();
    fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap().to_str().unwrap().to_owned();
    let script = r#"#!/bin/sh
state='STATE'
shift
for last; do :; done
case "$1 $2" in
    'ls --json')
        [ -f "$state/slow-ls" ] && /bin/sleep 20
        exec /bin/cat "$state/sessions.json" ;;
    'window ls') exec /bin/cat "$state/windows.json" ;;
    'block call')
        [ -f "$state/slow-process" ] && /bin/sleep 20
        [ -f "$state/fail-process" ] && exit 1
        exec /bin/cat "$state/process.json" ;;
    'api call')
        [ -f "$state/fail-paste" ] && exit 1
        /bin/cat > "$state/pasted"
        [ -f "$state/process-after-paste.json" ] &&
            /bin/cp "$state/process-after-paste.json" "$state/process.json"
        exit 0 ;;
    'send-key -s')
        [ -f "$state/fail-enter" ] && exit 1
        : > "$state/entered" ;;
    'new --json')
        [ -f "$state/fail-new" ] && exit 1
        printf '%s' "$last" > "$state/started"
        exec /bin/cat "$state/created.json" ;;
    *) exit 64 ;;
esac
"#;
    sandbox.executable("rex", &script.replace("STATE", state.to_str().unwrap()));
    sandbox.executable("claude", "#!/bin/sh\nexit 64\n");
    let files = [
        (
            "sessions.json",
            json!({"sessions":[{"session_id":REX_SESSION,"label":"Site"}]}),
        ),
        (
            "windows.json",
            json!({"windows":[{"label":"Main","layers":[{"blocks":[
                {"creator_name":"com.superlogical.terminal","block_id":REX_BLOCK,"label":"shell"},
                {"creator_name":"com.example.browser","block_id":"block:other"}]}]}]}),
        ),
        (
            "process.json",
            json!({"foreground":{"name":"claude","pid":4242,"cwd":project}}),
        ),
        (
            "created.json",
            json!({"session_id":REX_SESSION,"initial_windows":[{"block_ids":[REX_BLOCK]}]}),
        ),
    ];
    for (name, content) in files {
        fs::write(state.join(name), content.to_string()).unwrap();
    }
    (state, project)
}
fn rex_target(sandbox: &Sandbox) -> Value {
    let reply = sandbox.request(json!({"op":"targets"}));
    assert_eq!(reply["checks"][3]["eligible"], 1, "{reply}");
    reply["targets"][0].clone()
}

#[test]
fn a_rex_pane_send_is_submitted_and_classified_at_each_step() {
    let sandbox = Sandbox::new();
    let (state, project) = install_fake_rex(&sandbox);
    let listed = sandbox.request(json!({"op":"targets"}));
    assert_eq!(listed["starts"], json!(["claude"]));
    assert_eq!(
        listed["checks"][3],
        json!({"route":"rex","found":1,"eligible":1,"detail":"1 Rex pane can receive notes."})
    );
    let target = rex_target(&sandbox);
    assert_eq!(target["session"], REX_SESSION);
    assert_eq!(target["block"], REX_BLOCK);
    assert_eq!(target["project"], project);

    let sent = sandbox.send(&target);
    assert_eq!(sent["ok"], true, "{sent}");
    assert_eq!(sent["receipt"], "submitted");
    assert!(sent["notice"].as_str().unwrap().contains("no receipt"));
    let event: Value = serde_json::from_slice(&fs::read(state.join("pasted")).unwrap()).unwrap();
    assert_eq!(event["block_id"], REX_BLOCK);
    assert_batch_content(
        &sandbox,
        event["event"]["payload"]["text"].as_str().unwrap(),
    );
    assert!(state.join("entered").exists());

    let reset = || {
        for name in ["pasted", "entered"] {
            let _ = fs::remove_file(state.join(name));
        }
    };
    // Enter fails after the paste landed.
    reset();
    fs::write(state.join("fail-enter"), "").unwrap();
    assert!(is_uncertain_failure(&sandbox.send(&target)));
    assert!(state.join("pasted").exists());
    fs::remove_file(state.join("fail-enter")).unwrap();

    // The paste command ran and failed: it may have typed part of the batch.
    reset();
    fs::write(state.join("fail-paste"), "").unwrap();
    assert!(is_uncertain_failure(&sandbox.send(&target)));
    assert!(!state.join("entered").exists());
    fs::remove_file(state.join("fail-paste")).unwrap();

    // Another program took the foreground between paste and Enter.
    reset();
    let original = fs::read(state.join("process.json")).unwrap();
    let shell = json!({"foreground":{"name":"zsh","pid":4243,"cwd":project}});
    fs::write(state.join("process-after-paste.json"), shell.to_string()).unwrap();
    assert!(is_uncertain_failure(&sandbox.send(&target)));
    assert!(state.join("pasted").exists() && !state.join("entered").exists());
    fs::remove_file(state.join("process-after-paste.json")).unwrap();
    fs::write(state.join("process.json"), original).unwrap();

    // The agent changed before anything was pasted.
    reset();
    let mut stale = target.clone();
    stale["identity"] = json!("claude:1");
    assert!(is_plain_failure(&sandbox.send(&stale)));
    fs::write(state.join("fail-process"), "").unwrap();
    let written = fs::read_dir(sandbox.shots()).unwrap().count();
    assert!(is_plain_failure(&sandbox.send(&target)));
    assert!(!state.join("pasted").exists() && !state.join("entered").exists());
    assert_eq!(fs::read_dir(sandbox.shots()).unwrap().count(), written);
    let listed = sandbox.request(json!({"op":"targets"}));
    assert_eq!(listed["checks"][3]["found"], 1);
    assert_eq!(listed["checks"][3]["eligible"], 0);
    assert!(listed["checks"][3]["detail"]
        .as_str()
        .unwrap()
        .contains("none has Codex or Claude Code in the foreground"));
}

#[test]
fn a_rex_start_is_submitted_and_uncertain_once_rex_ran() {
    let sandbox = Sandbox::new();
    let (state, project) = install_fake_rex(&sandbox);
    let start = |agent: &str| {
        sandbox.request(json!({"op":"start","agent":agent,"project":project,
            "page":"https://example.test/pricing?plan=pro","notes":notes()}))
    };
    let started = start("claude");
    assert_eq!(started["ok"], true, "{started}");
    assert_eq!(started["receipt"], "submitted");
    assert!(started["notice"].is_string());
    assert_eq!(started["target"]["session"], REX_SESSION);
    assert_eq!(started["target"]["block"], REX_BLOCK);
    assert_eq!(started["target"]["project"], project);
    assert_batch_content(
        &sandbox,
        &fs::read_to_string(state.join("started")).unwrap(),
    );

    // Codex is not installed here, so Rex is never asked to launch it.
    fs::remove_file(state.join("started")).unwrap();
    let written = fs::read_dir(sandbox.shots()).unwrap().count();
    assert!(is_plain_failure(&start("codex")));
    assert!(!state.join("started").exists());
    assert_eq!(fs::read_dir(sandbox.shots()).unwrap().count(), written);

    // Rex ran the launch and reported failure: the session may exist.
    fs::write(state.join("fail-new"), "").unwrap();
    let failed = start("claude");
    assert!(is_uncertain_failure(&failed), "{failed}");
    fs::remove_file(state.join("fail-new")).unwrap();

    // Rex launched the session but the agent never appeared in it.
    fs::write(state.join("fail-process"), "").unwrap();
    let unconfirmed = start("claude");
    assert!(is_uncertain_failure(&unconfirmed), "{unconfirmed}");
    assert!(state.join("started").exists());
}

#[test]
fn every_invocation_prunes_images_older_than_seven_days() {
    let sandbox = Sandbox::new();
    let shots = sandbox.shots();
    fs::create_dir_all(&shots).unwrap();
    let eight_days = Duration::from_secs(8 * 24 * 60 * 60);
    for name in ["note-old.jpg", "note-reference-old.jpg"] {
        let file = fs::File::create(shots.join(name)).unwrap();
        file.set_modified(SystemTime::now() - eight_days).unwrap();
    }
    let six_days = Duration::from_secs(6 * 24 * 60 * 60);
    let recent = fs::File::create(shots.join("note-recent.jpg")).unwrap();
    recent.set_modified(SystemTime::now() - six_days).unwrap();
    // No batch and no images in this request.
    sandbox.request(json!({"op":"capabilities"}));
    let left: Vec<_> = fs::read_dir(&shots)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["note-recent.jpg"]);

    // A cache that cannot be read does not fail the request.
    fs::set_permissions(&shots, fs::Permissions::from_mode(0o000)).unwrap();
    let reply = sandbox.request(json!({"op":"capabilities"}));
    fs::set_permissions(&shots, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(reply["ok"], true);
}

#[test]
fn uninstall_removes_saved_images() {
    let sandbox = Sandbox::new();
    let uninstall = || {
        let output = sandbox
            .host()
            .args(["register", "uninstall"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    };
    let shots = sandbox.shots();
    fs::create_dir_all(&shots).unwrap();
    fs::write(shots.join("note-a.jpg"), "image").unwrap();
    fs::write(shots.join("note-reference-b.jpg"), "image").unwrap();
    assert!(uninstall().contains("saved screenshots"));
    assert!(!shots.exists());
    // Nothing to remove is not an error.
    uninstall();

    // A link in place of the directory is never followed.
    let elsewhere = sandbox.path("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    fs::write(elsewhere.join("keep.jpg"), "image").unwrap();
    std::os::unix::fs::symlink(&elsewhere, &shots).unwrap();
    uninstall();
    assert!(elsewhere.join("keep.jpg").exists());
}

#[test]
fn a_send_to_a_closed_destination_leaves_no_images_behind() {
    let sandbox = Sandbox::new();
    serve_codex(&sandbox.path("codex.sock"), Turn::Accept);
    let inbox = open_claude_inbox(&sandbox);
    let listed = sandbox.request(json!({"op":"targets"}));
    let targets = listed["targets"].as_array().unwrap().clone();
    assert_eq!(targets.len(), 2);
    drop(inbox);
    fs::remove_file(sandbox.path("codex.sock")).unwrap();
    for target in &targets {
        let reply = sandbox.send(target);
        assert!(is_plain_failure(&reply), "{reply}");
    }
    assert!(!sandbox.shots().exists());
}

// Every poll of the new pane hangs until its own limit. Unbounded, ten polls take 150 seconds,
// past the 120 seconds the extension waits.
#[test]
fn a_rex_start_that_cannot_be_confirmed_answers_within_its_budget() {
    let sandbox = Sandbox::new();
    let (state, project) = install_fake_rex(&sandbox);
    fs::write(state.join("slow-process"), "").unwrap();
    let begun = Instant::now();
    let reply = sandbox.request(json!({"op":"start","agent":"claude","project":project,
        "page":"https://example.test/pricing?plan=pro","notes":notes()}));
    let took = begun.elapsed();
    assert!(is_uncertain_failure(&reply), "{reply}");
    assert!(state.join("started").exists());
    assert!(took >= Duration::from_secs(25), "{took:?}");
    assert!(took < Duration::from_secs(45), "{took:?}");
}

// Rex hangs before anything was launched: the per-command limit ends it as a definite failure.
#[test]
fn a_rex_start_that_hangs_before_launch_is_a_plain_failure() {
    let sandbox = Sandbox::new();
    let (state, project) = install_fake_rex(&sandbox);
    fs::write(state.join("slow-ls"), "").unwrap();
    let begun = Instant::now();
    let reply = sandbox.request(json!({"op":"start","agent":"claude","project":project,
        "page":"https://example.test/pricing?plan=pro","notes":notes()}));
    assert!(is_plain_failure(&reply), "{reply}");
    assert!(!state.join("started").exists());
    assert!(!sandbox.shots().exists());
    assert!(begun.elapsed() < Duration::from_secs(25));
}

// A pane whose process check hangs after the paste: Enter is never pressed, the answer is
// uncertain and arrives after two command limits, not after the extension gave up.
#[test]
fn a_rex_send_that_hangs_after_the_paste_is_uncertain_and_bounded() {
    let sandbox = Sandbox::new();
    let (state, _) = install_fake_rex(&sandbox);
    let target = rex_target(&sandbox);
    // The paste itself switches the fake into its slow mode.
    let script = fs::read_to_string(sandbox.path("bin/rex")).unwrap();
    let slow_after_paste = script.replace(
        "/bin/cat > \"$state/pasted\"",
        "/bin/cat > \"$state/pasted\"; : > \"$state/slow-process\"",
    );
    assert_ne!(script, slow_after_paste);
    sandbox.executable("rex", &slow_after_paste);
    let begun = Instant::now();
    let reply = sandbox.send(&target);
    assert!(is_uncertain_failure(&reply), "{reply}");
    assert!(state.join("pasted").exists() && !state.join("entered").exists());
    assert!(begun.elapsed() < Duration::from_secs(40));
}
