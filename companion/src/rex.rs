use super::*;
use fs2::FileExt;
use std::fs::{File, OpenOptions};
fn call(args: &[&str], data: &str, start: bool) -> Result<String> {
    let mut items = vec![if start {
        "--autostart=true"
    } else {
        "--autostart=false"
    }];
    items.extend(args);
    run("rex", &items, data, 15)
}
fn read(args: &[&str], start: bool) -> Result<Value> {
    Ok(serde_json::from_str(&call(args, "", start)?)?)
}
pub(super) fn lock(name: &str) -> Result<File> {
    let dir = home()?.join("Library/Caches/com.micovi.paneparcel");
    fs::create_dir_all(&dir)?;
    let f = OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join(name))?;
    f.try_lock_exclusive()
        .context("Another batch is being delivered. Try again shortly.")?;
    Ok(f)
}
fn identity(r: &Value) -> Result<(&str, &str)> {
    let s = string(r, "session")?;
    let b = string(r, "block")?;
    ensure!(
        s.strip_prefix("session:").is_some_and(uuid) && b.strip_prefix("block:").is_some_and(uuid),
        "Invalid Rex destination."
    );
    Ok((s, b))
}
#[derive(PartialEq)]
struct Agent {
    name: String,
    pid: u64,
    project: String,
}
fn foreground(s: &str, b: &str) -> Result<Agent> {
    let info = read(&["block", "call", "-s", s, "-b", b, "process"], false)?;
    let fg = &info["foreground"];
    let extra = setup::extra_agents()?;
    let script = fg["script"].as_str().unwrap_or("");
    let package = if script.contains("/@anthropic-ai/claude-code/") {
        "claude"
    } else if script.contains("/@openai/codex/") {
        "codex"
    } else {
        ""
    };
    let name = ["script", "invoked_path", "name", "argv0"]
        .iter()
        .filter_map(|k| Path::new(fg[k].as_str()?).file_name()?.to_str())
        .chain([package])
        .find(|n| ["codex", "claude"].contains(n) || extra.iter().any(|s| s == n))
        .context("The selected pane no longer contains a supported foreground agent.")?;
    Ok(Agent {
        name: name.into(),
        pid: fg["pid"]
            .as_u64()
            .filter(|n| *n > 0)
            .context("Missing Rex PID")?,
        project: project(&json!({"project":fg["cwd"]}))?,
    })
}
fn title(name: &str) -> &str {
    match name {
        "codex" => "Codex",
        "claude" => "Claude Code",
        v => v,
    }
}
fn target(s: &str, b: &str, a: &Agent, label: &str) -> Value {
    let agent = title(&a.name);
    let label = if label.contains(&format!(" · {agent}")) {
        label.to_owned()
    } else {
        format!("{agent} · {label}")
    };
    json!({"session":s,"block":b,"project":a.project,"identity":format!("{}:{}",a.name,a.pid),"label":label})
}
pub fn targets() -> Vec<Value> {
    let mut out = vec![];
    let Ok(sessions) = read(&["ls", "--json"], false) else {
        return out;
    };
    for (si, session) in list(&sessions["sessions"]).enumerate() {
        let Some(s) = session["session_id"].as_str() else {
            continue;
        };
        let Ok(windows) = read(&["window", "ls", "-s", s, "--json"], false) else {
            continue;
        };
        for (i, w) in list(&windows["windows"]).enumerate() {
            for (j, pane) in list(&w["layers"])
                .flat_map(|l| list(&l["blocks"]))
                .enumerate()
            {
                if pane["creator_name"] != "com.superlogical.terminal" {
                    continue;
                }
                if let Some(b) = pane["block_id"].as_str() {
                    if let Ok(a) = foreground(s, b) {
                        let label = format!(
                            "{} ({}) / Tab {} {} / Pane {} {}",
                            session["label"].as_str().unwrap_or("Session"),
                            si + 1,
                            i + 1,
                            w["label"].as_str().unwrap_or(""),
                            j + 1,
                            pane["label"].as_str().unwrap_or("")
                        );
                        out.push(target(s, b, &a, &label))
                    }
                }
            }
        }
    }
    out
}
pub fn send(r: &Value, msg: &str) -> Result<()> {
    let (s, b) = identity(r)?;
    let _guard = lock("delivery.lock")?;
    let a = foreground(s, b)?;
    if !r["identity"].is_null() {
        ensure!(
            r["identity"] == format!("{}:{}", a.name, a.pid),
            "The selected foreground agent changed. Refresh destinations."
        );
    }
    if !r["project"].is_null() {
        ensure!(
            project(r)? == a.project,
            "The pane changed project. Refresh destinations."
        );
    }
    let event =
        json!({"session_id":s,"block_id":b,"event":{"type":"paste","payload":{"text":msg}}});
    let uncertain = "Delivery is uncertain. Inspect the Rex prompt before retrying.";
    call(
        &["api", "call", "block.event", "-"],
        &event.to_string(),
        false,
    )
    .context(uncertain)?;
    ensure!(foreground(s, b).context(uncertain)? == a, "{uncertain}");
    call(&["send-key", "-s", s, "-b", b, "enter"], "", false).context(uncertain)?;
    Ok(())
}
pub fn start(r: &Value, msg: &str) -> Result<Value> {
    let agent = string(r, "agent")?;
    ensure!(["claude", "codex"].contains(&agent), "Unknown agent.");
    let exe = executable(agent).context("Install this agent and rerun the installer.")?;
    let p = project(r)?;
    let _guard = lock("session-names.lock")?;
    let sessions = read(&["ls", "--json"], true)?;
    let mut folder = Path::new(&p)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Root")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    while folder.len() > 90 {
        folder.pop();
    }
    if folder.starts_with('-') {
        folder.insert_str(0, "./");
    }
    let base = format!("{folder} · {}", title(agent));
    let mut name = base.clone();
    let mut n = 1;
    while list(&sessions["sessions"]).any(|v| v["label"] == name) {
        n += 1;
        name = format!("{base} ({n})");
    }
    let created = read(
        &[
            "new",
            "--json",
            "--shell=none",
            "--cwd",
            &p,
            "--window",
            "Notes",
            &name,
            "--",
            "/usr/bin/env",
            &format!("PATH={}", env::var("PATH")?),
            exe.to_str().context("Invalid CLI path")?,
            msg,
        ],
        true,
    )
    .context("Could not confirm session creation. Inspect Rex before retrying.")?;
    let s = string(&created, "session_id")?;
    let b = created["initial_windows"][0]["block_ids"][0]
        .as_str()
        .context("Inspect the new Rex session before retrying.")?;
    for _ in 0..10 {
        thread::sleep(Duration::from_millis(250));
        if let Ok(a) = foreground(s, b) {
            if a.name == agent && a.project == p {
                return Ok(target(s, b, &a, &name));
            }
        }
    }
    bail!("Could not confirm the new conversation. Inspect Rex before retrying.")
}
pub fn focus(r: &Value) -> Result<()> {
    let (s, b) = identity(r)?;
    let win =
        read(&["block", "inspect", "-s", s, b, "--json"], false)?["block"]["window_id"].clone();
    run("/usr/bin/open", &["-b", "com.superlogical.rex"], "", 5)?;
    for _ in 0..12 {
        let clients = read(&["client", "ls", "--json"], false)?;
        let apps: Vec<_> = list(&clients["clients"])
            .filter(|c| {
                c["info"]["name"] == "Rex"
                    && c["info"]["platform"] == "macos"
                    && c["principal"]["transport"] == "unix"
                    && c["connection_state"] == "connected"
            })
            .collect();
        if let Some(c) = apps
            .iter()
            .find(|c| list(&c["session_ids"]).any(|v| v == s))
            .or(apps.first())
        {
            let action = json!({"client_id":c["client_id"],"action":"session.select","args":{"session_id":s,"window_id":win}});
            call(
                &["api", "call", "client.perform", "-"],
                &action.to_string(),
                false,
            )?;
            call(&["focus", "-s", s, b], "", false)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    bail!("Rex did not connect.")
}
