use super::*;
fn proc_info(pid: u32) -> Result<(String, u32, String)> {
    let info = run(
        "/bin/ps",
        &[
            "-p",
            &pid.to_string(),
            "-o",
            "tty=,pgid=,tpgid=,ppid=,comm=",
        ],
        "",
        2,
    )?;
    let mut fields = info.split_whitespace();
    let tty = fields.next().context("Missing TTY")?;
    let pg = fields.next().context("Missing process group")?;
    ensure!(
        pg == fields.next().unwrap_or("") && tty.starts_with("tty"),
        "Agent is not in foreground."
    );
    let parent = fields.next().context("Missing parent")?.parse()?;
    Ok((
        format!("/dev/{tty}"),
        parent,
        fields.collect::<Vec<_>>().join(" "),
    ))
}
fn app(mut parent: u32) -> Option<&'static str> {
    for _ in 0..16 {
        if parent <= 1 {
            break;
        }
        let v = run(
            "/bin/ps",
            &["-p", &parent.to_string(), "-o", "ppid=,comm="],
            "",
            2,
        )
        .ok()?;
        let mut fields = v.split_whitespace();
        parent = fields.next()?.parse().ok()?;
        let name = fields.collect::<Vec<_>>().join(" ");
        if name.ends_with("/Terminal.app/Contents/MacOS/Terminal") {
            return Some("Terminal");
        }
        if name.contains("/iTerm.app/") || name.contains("/iTerm2.app/") {
            return Some("iTerm2");
        }
        if name.contains("tmux") {
            break;
        }
    }
    None
}
pub(super) fn focus_destination(pid: u32) -> Option<(&'static str, String)> {
    let (tty, parent, _) = proc_info(pid).ok()?;
    Some((app(parent)?, tty))
}
pub(super) fn targets() -> Result<Vec<Value>> {
    let dir = codex::directory()?;
    let locks = dir.join("thread-writer-locks");
    if !locks.is_dir() {
        return Ok(vec![]);
    }
    let held = run(
        "/usr/sbin/lsof",
        &[
            "-nP",
            "-Fpcn",
            "+d",
            locks.to_str().context("Invalid Codex home")?,
        ],
        "",
        5,
    )?;
    let mut owners: HashMap<u32, Vec<String>> = HashMap::new();
    let mut pid = 0;
    let mut agent = false;
    for line in held.lines() {
        if let Some(s) = line.strip_prefix('p') {
            pid = s.parse()?;
            agent = false;
        }
        if let Some(s) = line.strip_prefix('c') {
            agent = s == "codex";
        }
        if let Some(path) = line.strip_prefix('n').filter(|_| agent) {
            if let Some(id) = Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| uuid(s))
            {
                owners.entry(pid).or_default().push(id.into());
            }
        }
    }
    let db = dir.join("state_5.sqlite");
    if !db.is_file() {
        return Ok(vec![]);
    }
    let ids = owners
        .values()
        .flatten()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(",");
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let sql = format!(
        "SELECT id,cwd,name FROM threads WHERE archived=0 AND source='cli' AND id IN ({ids})"
    );
    let raw = run(
        "/usr/bin/sqlite3",
        &[
            "-readonly",
            "-json",
            db.to_str().context("Invalid Codex home")?,
            &sql,
        ],
        "",
        3,
    )?;
    let rows: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let panes = run(
        "tmux",
        &[
            "-N",
            "list-panes",
            "-a",
            "-F",
            "#{pane_id} #{pane_tty} #{pane_in_mode} #{synchronize-panes} #{pane_current_command}",
        ],
        "",
        3,
    )
    .unwrap_or_default();
    let queue = run("codex", &["queue", "--help"], "", 4)
        .is_ok_and(|s| s.contains("--thread") && s.contains("--message"));
    let mut out = vec![];
    for (pid, ids) in owners {
        if ids.len() != 1 {
            continue;
        }
        let id = &ids[0];
        if !dir
            .join("tui-thread-reference-capabilities")
            .join(id)
            .is_file()
        {
            continue;
        }
        let Some(row) = list(&rows).find(|r| r["id"] == *id) else {
            continue;
        };
        let Ok((tty, parent, command)) = proc_info(pid) else {
            continue;
        };
        if Path::new(&command).file_name().is_none_or(|s| s != "codex") {
            continue;
        }
        let pane = panes
            .lines()
            .filter_map(|s| {
                let v: Vec<_> = s.split_whitespace().collect();
                (v.len() == 5 && v[1] == tty && v[2] == "0" && v[3] == "0" && v[4] == "codex")
                    .then(|| v[0])
            })
            .next();
        let route = if pane.is_some() {
            Some("tmux")
        } else {
            app(parent)
        };
        for method in route.into_iter().chain(queue.then_some("codex-queue")) {
            let mode = if method == "codex-queue" {
                "deferred queue · UI may require reopening"
            } else if method == "Terminal" {
                "Terminal.app Automation (preview)"
            } else if method == "iTerm2" {
                "iTerm2 Automation (preview)"
            } else {
                method
            };
            let label = format!(
                "Codex · {} · {} · {mode}",
                row["name"].as_str().unwrap_or("Terminal"),
                &id[..8]
            );
            let mut t = make(method, &format!("{id}:{pid}"), string(row, "cwd")?, &label);
            t["pid"] = json!(pid);
            t["tty"] = json!(tty);
            t["pane"] = json!(pane);
            out.push(t);
        }
    }
    Ok(out)
}
fn apple(t: &Value, msg: &str, focus: bool) -> Result<()> {
    let terminal = t["session"] == "Terminal";
    let script = match (terminal, focus) {
        (true, false) => {
            r#"on run argv
tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is item 1 of argv then
do script (item 2 of argv) in t
return
end if
end repeat
end repeat
end tell
error "Terminal tab closed"
end run"#
        }
        (true, true) => {
            r#"on run argv
tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is item 1 of argv then
set selected tab of w to t
set index of w to 1
activate
return
end if
end repeat
end repeat
end tell
error "Terminal tab closed"
end run"#
        }
        (false, _) => {
            r#"on run argv
tell application id "com.googlecode.iterm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
if tty of s is item 1 of argv then
if item 3 of argv is "focus" then
select w
select t
select s
activate
else
tell s to write text (item 2 of argv)
end if
return
end if
end repeat
end repeat
end repeat
end tell
error "iTerm session closed"
end run"#
        }
    };
    run("/usr/bin/osascript",&["-e",script,"--",string(t,"tty")?,msg,if focus{"focus"}else{"send"}],"",30)
        .context("Inspect the terminal before retrying. Check macOS Automation permission and the selected tab.")?;
    Ok(())
}
pub(super) fn focus(t: &Value) -> Result<()> {
    ensure!(
        matches!(t["session"].as_str(), Some("Terminal" | "iTerm2")),
        "Focus unavailable."
    );
    apple(t, "", true)
}
pub(super) fn send(t: &Value, msg: &str) -> Result<&'static str> {
    let id = string(t, "block")?
        .split(':')
        .nth(1)
        .context("Missing thread ID")?;
    match string(t, "session")? {
        "codex-queue" => {
            ensure!(uuid(id), "Invalid thread");
            run(
                "codex",
                &["queue", "--thread", id, "--message", msg],
                "",
                10,
            )
            .context("Codex did not confirm queueing. Inspect the thread before retrying.")?;
            Ok("Queued on the exact Codex thread. Its current terminal may require reopening to show it.")
        }
        "tmux" => {
            let _guard = rex::lock("delivery.lock")?;
            let p = string(t, "pane")?;
            let buffer = format!("paneparcel-{}", std::process::id());
            run("tmux", &["load-buffer", "-b", &buffer, "-"], msg, 3)?;
            let paste = run(
                "tmux",
                &["paste-buffer", "-p", "-d", "-b", &buffer, "-t", p],
                "",
                3,
            );
            if paste.is_err() {
                let _ = run("tmux", &["delete-buffer", "-b", &buffer], "", 3);
            }
            let check = "Inspect the selected tmux pane before retrying.";
            paste.context(check)?;
            matching(t, targets().context(check)?).context(check)?;
            run("tmux", &["send-keys", "-t", p, "Enter"], "", 3).context(check)?;
            Ok("Submitted through the selected tmux pane.")
        }
        "Terminal" | "iTerm2" => {
            // A first Apple event can wait on a macOS Automation permission prompt.
            // Acquire permission before checking the foreground owner a final time.
            let probe = if t["session"] == "Terminal" {
                r#"tell application "Terminal" to get version"#
            } else {
                r#"tell application id "com.googlecode.iterm2" to get version"#
            };
            run("/usr/bin/osascript", &["-e", probe], "", 60).context(
                "Allow terminal Automation in System Settings, then refresh destinations.",
            )?;
            let _guard = rex::lock("delivery.lock")?;
            let current = matching(t, targets()?)?;
            ensure!(
                current["tty"] == t["tty"],
                "Terminal tab changed. Refresh destinations."
            );
            apple(&current, msg, false)?;
            Ok("Submitted through the selected terminal tab.")
        }
        _ => bail!("Unknown terminal route"),
    }
}
