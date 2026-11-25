use super::*;
fn proc_info(pid: u32) -> Result<(String, String)> {
    let info = run(
        "/bin/ps",
        &["-p", &pid.to_string(), "-o", "tty=,pgid=,tpgid=,comm="],
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
    Ok((format!("/dev/{tty}"), fields.collect::<Vec<_>>().join(" ")))
}
pub(super) fn discover() -> Discovery {
    inspect().unwrap_or_else(|_| {
        Discovery::none(
            "Codex terminal sessions could not be inspected; refresh destinations to try again.",
        )
    })
}
fn inspect() -> Result<Discovery> {
    let idle = "No Codex terminal session is running; start codex inside tmux, then refresh.";
    let dir = codex::directory()?;
    let locks = dir.join("thread-writer-locks");
    if !locks.is_dir() {
        return Ok(Discovery::none(idle));
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
    let found = owners.len();
    if found == 0 {
        return Ok(Discovery::none(idle));
    }
    let ids = owners
        .values()
        .flatten()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id,cwd,name FROM threads WHERE archived=0 AND source='cli' AND id IN ({ids})"
    );
    let db = dir.join("state_5.sqlite");
    let rows: Value = if db.is_file() {
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
        serde_json::from_str(&raw).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
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
        let Some(project) = row["cwd"].as_str() else {
            continue;
        };
        let Ok((tty, command)) = proc_info(pid) else {
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
        if let Some(pane) = pane {
            let label = format!(
                "Codex · {} · {} · tmux",
                row["name"].as_str().unwrap_or("Terminal"),
                &id[..8]
            );
            let mut t = make("tmux", &format!("{id}:{pid}"), project, &label);
            t["pane"] = json!(pane);
            out.push(t);
        }
    }
    let detail = if !out.is_empty() {
        format!(
            "{} can receive notes through tmux.",
            count(out.len(), "Codex terminal session")
        )
    } else if executable("tmux").is_none() {
        "Codex is running in a terminal, but tmux is not on the helper's PATH; rerun the \
         Nitpost installer from a terminal where tmux works."
            .into()
    } else {
        "Codex is running in a terminal, but not in the foreground of a tmux pane with a saved \
         thread; run it in tmux with copy mode and synchronized panes off, then refresh."
            .into()
    };
    Ok(Discovery {
        targets: out,
        found,
        detail,
    })
}
pub(super) fn send(t: &Value, batch: Batch) -> Result<()> {
    let _guard = rex::lock("delivery.lock")?;
    deliver(
        t,
        &batch.message()?,
        |args, input| run("tmux", args, input, 3),
        || discover().targets,
    )
}
// Loading the buffer only reaches the tmux server. From the paste on, the agent may hold
// the text, so every later failure is uncertain.
fn deliver(
    t: &Value,
    msg: &str,
    mut tmux: impl FnMut(&[&str], &str) -> Result<String>,
    rediscover: impl FnOnce() -> Vec<Value>,
) -> Result<()> {
    let p = string(t, "pane")?;
    let buffer = format!("nitpost-{}", std::process::id());
    tmux(&["load-buffer", "-b", &buffer, "-"], msg)?;
    let paste = tmux(&["paste-buffer", "-p", "-d", "-b", &buffer, "-t", p], "");
    if paste.is_err() {
        let _ = tmux(&["delete-buffer", "-b", &buffer], "");
    }
    let check = "Delivery is uncertain: the notes may be in the tmux pane without Enter \
                 pressed. Check the selected tmux pane before sending again.";
    uncertain_once_started(paste, check)?;
    uncertain(matching(t, rediscover()), check)?;
    uncertain(tmux(&["send-keys", "-t", p, "Enter"], ""), check)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> Value {
        let mut t = make("tmux", "thread:7", "/work/site", "Codex");
        t["pane"] = json!("%3");
        t
    }
    // Runs a delivery against a scripted tmux. `failing` names the subcommand that fails,
    // `unstarted` makes that failure a tmux that could not be launched at all.
    fn attempt(failing: &str, unstarted: bool, still_there: bool) -> (Value, Vec<String>) {
        let mut calls = vec![];
        let t = target();
        let result = deliver(
            &t,
            "notes",
            |args, _| {
                calls.push(args[0].to_owned());
                if args[0] != failing {
                    return Ok(String::new());
                }
                if unstarted {
                    return Err(anyhow::anyhow!("no tmux").context(Unstarted("tmux".into())));
                }
                bail!("tmux declined the request.")
            },
            || if still_there { vec![target()] } else { vec![] },
        );
        let reply = match result {
            Ok(()) => json!({"ok":true}),
            Err(e) => failure(&e, true),
        };
        (reply, calls)
    }
    #[test]
    fn tmux_pastes_then_rechecks_the_pane_before_enter() {
        let (reply, calls) = attempt("", false, true);
        assert_eq!(reply, json!({"ok":true}));
        assert_eq!(calls, ["load-buffer", "paste-buffer", "send-keys"]);
    }
    #[test]
    fn a_buffer_that_never_loaded_is_a_plain_failure() {
        let (reply, calls) = attempt("load-buffer", false, true);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["uncertain"], false, "{reply}");
        assert_eq!(calls, ["load-buffer"]);
    }
    #[test]
    fn a_paste_that_could_not_launch_tmux_is_a_plain_failure() {
        let (reply, calls) = attempt("paste-buffer", true, true);
        assert_eq!(reply["uncertain"], false, "{reply}");
        assert_eq!(calls, ["load-buffer", "paste-buffer", "delete-buffer"]);
    }
    #[test]
    fn a_paste_that_failed_or_timed_out_is_uncertain_and_never_presses_enter() {
        let (reply, calls) = attempt("paste-buffer", false, true);
        assert_eq!(reply["uncertain"], true, "{reply}");
        assert_eq!(calls, ["load-buffer", "paste-buffer", "delete-buffer"]);
    }
    #[test]
    fn a_pane_that_changed_after_the_paste_is_uncertain_and_never_gets_enter() {
        let (reply, calls) = attempt("", false, false);
        assert_eq!(reply["uncertain"], true, "{reply}");
        assert_eq!(calls, ["load-buffer", "paste-buffer"]);
    }
    #[test]
    fn a_failed_enter_after_the_paste_is_uncertain() {
        for unstarted in [false, true] {
            let (reply, calls) = attempt("send-keys", unstarted, true);
            assert_eq!(reply["uncertain"], true, "{reply}");
            assert_eq!(calls, ["load-buffer", "paste-buffer", "send-keys"]);
        }
    }
}
