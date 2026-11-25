use super::*;
use std::{
    collections::HashMap,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt},
            net::UnixStream,
        },
    },
};
mod codex;
mod terminal;
pub fn is_agent(r: &Value) -> bool {
    matches!(
        r["session"].as_str(),
        Some("claude-inbox" | "codex-server" | "codex-queue" | "tmux" | "Terminal" | "iTerm2")
    )
}
pub fn targets() -> Result<Vec<Value>> {
    let mut out = claude().unwrap_or_default();
    let shared = codex::Server::connect().and_then(|mut server| server.targets());
    out.extend(shared.unwrap_or_default());
    out.extend(terminal::targets().unwrap_or_default());
    Ok(out)
}
fn make(route: &str, id: &str, project: &str, label: &str) -> Value {
    json!({"session":route,"block":format!("{route}:{id}"),"project":project,"label":label,"focusable":matches!(route,"Terminal"|"iTerm2")})
}
fn claude_home() -> Result<PathBuf> {
    Ok(env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".claude")))
}
fn claude() -> Result<Vec<Value>> {
    if !claude_home()?.join("sessions").is_dir() {
        return Ok(vec![]);
    }
    let rows: Value = serde_json::from_str(&run("claude", &["agents", "--json"], "", 6)?)?;
    let mut out = vec![];
    for row in list(&rows) {
        if let Ok((id, pid, sock)) = claude_record(row) {
            let project = string(row, "cwd")?;
            let label = format!(
                "Claude Code · {} · {} · peer inbox",
                row["name"].as_str().unwrap_or("Terminal"),
                &id[..8]
            );
            let mut t = make("claude-inbox", &format!("{id}:{pid}"), project, &label);
            if let Some((app, tty)) = terminal::focus_destination(pid) {
                t["focusable"] = json!(true);
                t["app"] = json!(app);
                t["tty"] = json!(tty);
            }
            t["socket"] = json!(sock);
            t["pid"] = json!(pid);
            out.push(t);
        }
    }
    Ok(out)
}
fn claude_record(row: &Value) -> Result<(&str, u32, PathBuf)> {
    ensure!(
        row["kind"] == "interactive" || row["kind"] == "background",
        "Unsupported Claude session"
    );
    let id = string(row, "sessionId")?;
    ensure!(uuid(id), "Invalid session ID");
    let pid = u32::try_from(row["pid"].as_u64().context("Missing pid")?)?;
    let record = claude_home()?.join(format!("sessions/{pid}.json"));
    let meta = record.symlink_metadata()?;
    ensure!(
        meta.is_file() && meta.len() < 262144 && meta.uid() == unsafe { libc::geteuid() },
        "Invalid session record"
    );
    let v: Value = serde_json::from_slice(&fs::read(record)?)?;
    ensure!(
        v["sessionId"] == id && v["pid"] == pid && v["cwd"] == row["cwd"],
        "Session changed"
    );
    let sock = PathBuf::from(string(&v, "messagingSocketPath")?);
    let meta = sock.symlink_metadata()?;
    ensure!(
        sock.is_absolute()
            && meta.file_type().is_socket()
            && meta.uid() == unsafe { libc::geteuid() },
        "No local inbox"
    );
    Ok((id, pid, sock))
}
pub fn public(mut t: Value) -> Value {
    if let Some(o) = t.as_object_mut() {
        for key in ["socket", "pid", "tty", "pane", "app"] {
            o.remove(key);
        }
    }
    t
}
fn matching(r: &Value, items: Vec<Value>) -> Result<Value> {
    items
        .into_iter()
        .find(|v| {
            v["session"] == r["session"] && v["block"] == r["block"] && v["project"] == r["project"]
        })
        .context("The selected conversation is unavailable or has changed. Refresh destinations.")
}
pub fn send(r: &Value, msg: &str) -> Result<Value> {
    let status = match string(r, "session")? {
        "claude-inbox" => {
            let t = matching(r, claude()?)?;
            let stream = UnixStream::connect(string(&t, "socket")?)?;
            check_peer(&stream, t["pid"].as_u64().context("Missing pid")? as i32)?;
            stream.set_write_timeout(Some(Duration::from_secs(3)))?;
            // Never copy Claude's own-child token or assert a permission class.
            let frame =
                json!({"type":"user","message":{"role":"user","content":msg},"from":"PaneParcel"});
            let mut bytes = serde_json::to_vec(&frame)?;
            bytes.push(b'\n');
            (&stream)
                .write_all(&bytes)
                .context("Inbox submission uncertain. Inspect Claude before retrying.")?;
            "Posted to the Claude inbox. Check the original terminal for receipt or approval, then remove the saved notes."
        }
        "codex-server" => {
            let mut server = codex::Server::connect()?;
            let t = matching(r, server.targets()?)?;
            server.send(&t, msg)?;
            "Submitted to the running Codex thread."
        }
        _ => {
            let t = matching(r, terminal::targets()?)?;
            terminal::send(&t, msg)?
        }
    };
    Ok(json!({"ok":true,"notice":status,"keepNotes":r["session"]=="claude-inbox"}))
}
pub fn focus(r: &Value) -> Result<()> {
    if r["session"] == "claude-inbox" {
        let mut t = matching(r, claude()?)?;
        t["session"] = t["app"].clone();
        return terminal::focus(&t);
    }
    let t = matching(r, terminal::targets()?)?;
    terminal::focus(&t)
}
fn check_peer(stream: &UnixStream, expected: i32) -> Result<()> {
    let mut pid = 0i32;
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut i32).cast(),
            &mut len,
        )
    };
    ensure!(
        rc == 0 && pid == expected,
        "The socket is no longer owned by the selected Claude process."
    );
    Ok(())
}
