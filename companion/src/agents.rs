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
        Some("claude-inbox" | "codex-server" | "tmux")
    )
}
// One route failing to answer must not hide the others, so each explains itself.
pub fn discover() -> [Discovery; 3] {
    [claude(), codex::discover(), terminal::discover()]
}
fn make(route: &str, id: &str, project: &str, label: &str) -> Value {
    json!({"session":route,"block":format!("{route}:{id}"),"project":project,"label":label})
}
fn claude_home() -> Result<PathBuf> {
    Ok(env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".claude")))
}
fn claude() -> Discovery {
    sessions().unwrap_or_else(|_| {
        Discovery::none(
            "Claude Code did not list its sessions; update Claude Code, then refresh destinations.",
        )
    })
}
fn sessions() -> Result<Discovery> {
    if executable("claude").is_none() {
        return Ok(Discovery::none(
            "Claude Code is not on the helper's PATH; rerun the PaneParcel installer from a \
             terminal where the claude command works.",
        ));
    }
    if !claude_home()?.join("sessions").is_dir() {
        return Ok(Discovery::none(
            "No Claude Code session is running; start claude in a terminal, then refresh.",
        ));
    }
    let rows: Value = serde_json::from_str(&run("claude", &["agents", "--json"], "", 6)?)?;
    let mut targets = vec![];
    let mut found = 0;
    for row in list(&rows) {
        if row["kind"] != "interactive" && row["kind"] != "background" {
            continue;
        }
        found += 1;
        let Ok((id, pid, sock)) = claude_record(row) else {
            continue;
        };
        let Some(project) = row["cwd"].as_str() else {
            continue;
        };
        let label = format!(
            "Claude Code · {} · {} · peer inbox",
            row["name"].as_str().unwrap_or("Terminal"),
            &id[..8]
        );
        let mut t = make("claude-inbox", &format!("{id}:{pid}"), project, &label);
        t["socket"] = json!(sock);
        t["pid"] = json!(pid);
        targets.push(t);
    }
    let detail = if !targets.is_empty() {
        format!(
            "{} can receive notes.",
            count(targets.len(), "Claude Code session")
        )
    } else if found == 0 {
        "No Claude Code session is running; start claude in a terminal, then refresh.".into()
    } else {
        format!(
            "{} found, but none has a peer inbox; open an interactive claude session in a \
             terminal, then refresh.",
            count(found, "Claude Code session")
        )
    };
    Ok(Discovery {
        targets,
        found,
        detail,
    })
}
fn claude_record(row: &Value) -> Result<(&str, u32, PathBuf)> {
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
pub fn send(r: &Value, batch: Batch) -> Result<Value> {
    match string(r, "session")? {
        "claude-inbox" => {
            post_to_inbox(r, batch)?;
            Ok(delivered(
                "unconfirmed",
                "Handed to the Claude inbox, which sends no receipt. Check that Claude terminal \
                 for the message: its inbound settings can hold or drop it.",
            ))
        }
        "codex-server" => {
            let mut server = codex::Server::connect()
                .context("The Codex app server is no longer running. Refresh destinations.")?;
            let t = matching(r, server.targets()?.1)?;
            server.send(&t, &batch.message()?)?;
            Ok(delivered(
                "confirmed",
                "Codex accepted the turn in the selected thread.",
            ))
        }
        _ => {
            let t = matching(r, terminal::discover().targets)?;
            terminal::send(&t, batch)?;
            Ok(delivered(
                "submitted",
                "Pasted into the selected tmux pane and pressed Enter. The pane sends no receipt.",
            ))
        }
    }
}
fn post_to_inbox(r: &Value, batch: Batch) -> Result<()> {
    let t = matching(r, claude().targets)?;
    let stream = UnixStream::connect(string(&t, "socket")?)
        .context("The selected Claude session is no longer listening. Refresh destinations.")?;
    check_peer(&stream, t["pid"].as_u64().context("Missing pid")? as i32)?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    // Never copy Claude's own-child token or assert a permission class.
    let msg = batch.message()?;
    let frame = json!({"type":"user","message":{"role":"user","content":msg},"from":"PaneParcel"});
    let mut bytes = serde_json::to_vec(&frame)?;
    bytes.push(b'\n');
    write_frame(&stream, &bytes)
}
// A frame the inbox never began to take is a plain failure. One cut short may still be read.
fn write_frame(mut inbox: impl Write, bytes: &[u8]) -> Result<()> {
    let mut sent = 0;
    while sent < bytes.len() {
        match inbox.write(&bytes[sent..]) {
            Ok(0) => break,
            Ok(n) => sent += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    if sent == bytes.len() {
        return Ok(());
    }
    ensure!(
        sent > 0,
        "The Claude inbox did not accept the notes, so nothing was delivered. Refresh destinations."
    );
    uncertain(
        Err(anyhow::anyhow!(
            "The inbox stopped reading after {sent} bytes."
        )),
        "Delivery is uncertain: the Claude inbox closed partway through. Check that Claude \
         terminal before sending again.",
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    // Accepts a fixed number of bytes, then fails like a closed inbox.
    struct Inbox {
        room: usize,
        taken: Vec<u8>,
    }
    impl Write for Inbox {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.room == 0 {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            let n = bytes.len().min(self.room).min(4);
            self.room -= n;
            self.taken.extend(&bytes[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    fn post(room: usize) -> (Result<()>, Vec<u8>) {
        let mut inbox = Inbox {
            room,
            taken: vec![],
        };
        let result = write_frame(&mut inbox, b"{\"type\":\"user\"}\n");
        (result, inbox.taken)
    }
    #[test]
    fn an_inbox_frame_is_written_whole_across_short_writes() {
        let (result, taken) = post(64);
        assert!(result.is_ok());
        assert_eq!(taken, b"{\"type\":\"user\"}\n");
    }
    #[test]
    fn an_inbox_that_takes_nothing_is_a_plain_failure() {
        let (result, taken) = post(0);
        let reply = failure(&result.unwrap_err(), true);
        assert!(taken.is_empty());
        assert_eq!(reply["uncertain"], false, "{reply}");
        assert!(reply["error"]
            .as_str()
            .unwrap()
            .contains("nothing was delivered"));
    }
    #[test]
    fn an_inbox_that_closes_partway_is_uncertain() {
        let (result, taken) = post(6);
        let reply = failure(&result.unwrap_err(), true);
        assert_eq!(taken, b"{\"type");
        assert_eq!(reply["uncertain"], true, "{reply}");
        assert!(reply["error"]
            .as_str()
            .unwrap()
            .starts_with("Delivery is uncertain"));
    }
    #[test]
    fn private_route_details_are_removed_before_a_target_is_listed() {
        let mut t = make("claude-inbox", "id:42", "/work/site", "Claude Code");
        t["socket"] = json!("/private/inbox.sock");
        t["pid"] = json!(42);
        t["pane"] = json!("%3");
        assert_eq!(
            public(t),
            json!({"session":"claude-inbox","block":"claude-inbox:id:42",
                "project":"/work/site","label":"Claude Code"})
        );
    }
}
