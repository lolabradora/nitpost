use super::*;
use fs2::FileExt;
use std::fs::{File, OpenOptions};
// The extension stops waiting for a send or start after 120 seconds. A slow Rex must not
// carry the helper past that, so a delivery runs against a deadline: each command keeps its
// usual limit while time remains, and a command whose turn comes too late never runs.
const COMMAND_LIMIT: u64 = 15;
const DELIVERY_BUDGET: Duration = Duration::from_secs(75);
const CONFIRM_BUDGET: Duration = Duration::from_secs(30);
fn call(args: &[&str], data: &str, start: bool, deadline: Option<Instant>) -> Result<String> {
    let mut limit = COMMAND_LIMIT;
    if let Some(deadline) = deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(
                anyhow::anyhow!("Rex took too long.").context(Unstarted("rex in time".into()))
            );
        }
        limit = limit.min(left.as_secs().max(1));
    }
    let mut items = vec![if start {
        "--autostart=true"
    } else {
        "--autostart=false"
    }];
    items.extend(args);
    run("rex", &items, data, limit)
}
fn read(args: &[&str], start: bool, deadline: Option<Instant>) -> Result<Value> {
    Ok(serde_json::from_str(&call(args, "", start, deadline)?)?)
}
pub(super) fn lock(name: &str) -> Result<File> {
    let dir = home()?.join("Library/Caches/com.micovi.nitpost");
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
fn foreground(s: &str, b: &str, deadline: Option<Instant>) -> Result<Agent> {
    let info = read(
        &["block", "call", "-s", s, "-b", b, "process"],
        false,
        deadline,
    )?;
    let fg = &info["foreground"];
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
        .find(|n| ["codex", "claude"].contains(n))
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
pub fn discover() -> Discovery {
    if executable("rex").is_none() {
        return Discovery::none(
            "Rex is not on the helper's PATH; Rex is optional, and after installing it you \
             rerun the Nitpost installer to list Rex panes and start new conversations.",
        );
    }
    let Ok(sessions) = read(&["ls", "--json"], false, None) else {
        return Discovery::none("Rex is not running; open Rex to list its panes.");
    };
    let mut out = vec![];
    let mut found = 0;
    for (si, session) in list(&sessions["sessions"]).enumerate() {
        let Some(s) = session["session_id"].as_str() else {
            continue;
        };
        let Ok(windows) = read(&["window", "ls", "-s", s, "--json"], false, None) else {
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
                let Some(b) = pane["block_id"].as_str() else {
                    continue;
                };
                found += 1;
                if let Ok(a) = foreground(s, b, None) {
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
    let detail = if !out.is_empty() {
        format!("{} can receive notes.", count(out.len(), "Rex pane"))
    } else if found == 0 {
        "Rex has no terminal pane open; open one and start codex or claude in it.".into()
    } else {
        format!(
            "{} found, but none has Codex or Claude Code in the foreground; start one there, \
             then refresh.",
            count(found, "Rex terminal pane")
        )
    };
    Discovery {
        targets: out,
        found,
        detail,
    }
}
pub fn send(r: &Value, batch: Batch) -> Result<()> {
    let (s, b) = identity(r)?;
    let _guard = lock("delivery.lock")?;
    let deadline = Some(Instant::now() + DELIVERY_BUDGET);
    let a = foreground(s, b, deadline)?;
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
    let msg = batch.message()?;
    let event =
        json!({"session_id":s,"block_id":b,"event":{"type":"paste","payload":{"text":msg}}});
    // Everything above only reads. From the paste on, the agent may hold the text.
    let check = "Delivery is uncertain: the notes may be in the Rex pane without Enter \
                 pressed. Check the selected Rex pane before sending again.";
    let paste = call(
        &["api", "call", "block.event", "-"],
        &event.to_string(),
        false,
        deadline,
    );
    uncertain_once_started(paste, check)?;
    let submit = || -> Result<()> {
        ensure!(
            foreground(s, b, deadline)? == a,
            "The foreground agent changed after the paste."
        );
        call(
            &["send-key", "-s", s, "-b", b, "enter"],
            "",
            false,
            deadline,
        )?;
        Ok(())
    };
    uncertain(submit(), check)
}
pub fn start(r: &Value, batch: Batch) -> Result<Value> {
    let agent = string(r, "agent")?;
    ensure!(["claude", "codex"].contains(&agent), "Unknown agent.");
    let exe = executable(agent).context("Install this agent and rerun the installer.")?;
    let p = project(r)?;
    let _guard = lock("session-names.lock")?;
    let deadline = Instant::now() + DELIVERY_BUDGET;
    let sessions = read(&["ls", "--json"], true, Some(deadline))?;
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
    let msg = batch.message()?;
    // The batch travels as an argument of the new session. Once Rex ran, it may have started.
    let check = "Delivery is uncertain: Rex may have started the new conversation with these \
                 notes. Check Rex before starting another.";
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
            &msg,
        ],
        true,
        Some(deadline),
    );
    let too_long = |e: &anyhow::Error| {
        e.root_cause()
            .downcast_ref::<io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(libc::E2BIG))
    };
    let created = match created {
        Err(e) if too_long(&e) => bail!(
            "The batch is too long to start a new conversation, so nothing was delivered. \
             Send fewer notes, or send to a running conversation."
        ),
        other => uncertain_once_started(other, check)?,
    };
    let confirm = || -> Result<Value> {
        let s = string(&created, "session_id")?;
        let b = created["initial_windows"][0]["block_ids"][0]
            .as_str()
            .context("Missing Rex pane")?;
        let deadline = deadline.min(Instant::now() + CONFIRM_BUDGET);
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(250));
            if Instant::now() >= deadline {
                break;
            }
            if let Ok(a) = foreground(s, b, Some(deadline)) {
                if a.name == agent && a.project == p {
                    return Ok(target(s, b, &a, &name));
                }
            }
        }
        bail!("The new conversation did not stay open.")
    };
    uncertain(confirm(), check)
}

#[cfg(test)]
mod tests {
    use super::*;
    // An expired deadline returns before Rex is launched, so these never run a real `rex`.
    fn late() -> Result<String> {
        call(&["send-key"], "", false, Some(Instant::now()))
    }
    #[test]
    fn a_command_whose_turn_comes_after_the_deadline_never_runs() {
        let error = late().unwrap_err();
        assert!(error.downcast_ref::<Unstarted>().is_some());
        assert_eq!(error.to_string(), "Could not run rex in time.");
    }
    #[test]
    fn running_out_of_time_before_the_paste_is_a_plain_failure() {
        let reply = failure(
            &uncertain_once_started(late(), "Check Rex.").unwrap_err(),
            true,
        );
        assert_eq!(reply["uncertain"], false, "{reply}");
    }
    #[test]
    fn running_out_of_time_after_the_paste_is_uncertain() {
        let reply = failure(&uncertain(late(), "Check Rex.").unwrap_err(), true);
        assert_eq!(
            reply,
            json!({"ok":false,"error":"Check Rex.","uncertain":true})
        );
    }
    #[test]
    fn the_budgets_leave_room_inside_the_extension_wait() {
        // Worst case: the last command starts just inside the budget and runs to its limit.
        let worst = DELIVERY_BUDGET + Duration::from_secs(COMMAND_LIMIT);
        assert!(worst <= Duration::from_secs(100));
        assert!(CONFIRM_BUDGET < DELIVERY_BUDGET);
    }
}
