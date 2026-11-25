use super::*;
use tungstenite::{Message, WebSocket};
pub(super) fn directory() -> Result<PathBuf> {
    Ok(env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".codex")))
}
fn socket() -> Result<PathBuf> {
    Ok(env::var_os("PANEPARCEL_CODEX_SOCKET")
        .map(PathBuf::from)
        .unwrap_or(directory()?.join("app-server-control/app-server-control.sock")))
}
pub(super) fn discover() -> Discovery {
    if !socket().is_ok_and(|path| path.exists()) {
        return Discovery::none(
            "No Codex app server is running; Codex in tmux or Rex is listed by those routes.",
        );
    }
    let Ok((found, targets)) = Server::connect().and_then(|mut server| server.targets()) else {
        return Discovery::none(
            "The Codex app server did not answer; restart Codex, then refresh destinations.",
        );
    };
    let detail = if !targets.is_empty() {
        format!(
            "{} can receive notes.",
            count(targets.len(), "Codex thread")
        )
    } else if found == 0 {
        "The Codex app server has no loaded thread; open a thread in Codex, then refresh.".into()
    } else {
        format!(
            "{} loaded, but none is an idle terminal thread; wait for the running turn to \
             finish, then refresh.",
            count(found, "Codex thread")
        )
    };
    Discovery {
        targets,
        found,
        detail,
    }
}
enum Reply {
    Result(Value),
    Declined,
}
pub(super) struct Server {
    socket: WebSocket<UnixStream>,
    id: u64,
}
impl Server {
    pub(super) fn connect() -> Result<Self> {
        let path = socket()?;
        let m = fs::metadata(&path)?;
        ensure!(
            m.file_type().is_socket() && m.uid() == unsafe { libc::geteuid() },
            "Invalid Codex owner socket"
        );
        let s = UnixStream::connect(path)?;
        let mut uid = 0;
        let mut gid = 0;
        ensure!(
            unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) } == 0
                && uid == unsafe { libc::geteuid() },
            "Codex server belongs to another account."
        );
        let timeout = Some(Duration::from_secs(4));
        s.set_read_timeout(timeout)?;
        s.set_write_timeout(timeout)?;
        let (socket, _) = tungstenite::client("ws://localhost/", s)?;
        let mut server = Self { socket, id: 0 };
        server.rpc(
            "initialize",
            json!({"clientInfo":{"name":"paneparcel","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        server.write(json!({"method":"initialized"}))?;
        Ok(server)
    }
    fn write(&mut self, v: Value) -> Result<()> {
        self.socket.send(Message::text(v.to_string()))?;
        Ok(())
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Reply> {
        self.id += 1;
        self.write(json!({"method":method,"params":params,"id":self.id}))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Message::Text(text) = self.socket.read()? {
                let v: Value = serde_json::from_str(&text)?;
                if v["id"] == self.id {
                    return Ok(match v.get("result") {
                        Some(result) => Reply::Result(result.clone()),
                        None => Reply::Declined,
                    });
                }
            }
        }
        bail!("Codex response timed out.")
    }
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        match self.call(method, params)? {
            Reply::Result(result) => Ok(result),
            Reply::Declined => bail!("Codex declined {method}. Check the selected terminal."),
        }
    }
    // Returns how many threads are loaded, and the ones that can take a turn now.
    pub(super) fn targets(&mut self) -> Result<(usize, Vec<Value>)> {
        let mut out = vec![];
        let mut found = 0;
        let mut cursor = Value::Null;
        loop {
            let page = self.rpc("thread/loaded/list", json!({"cursor":cursor,"limit":100}))?;
            for id in list(&page["data"]).filter_map(|id| id.as_str().filter(|s| uuid(s))) {
                found += 1;
                let Ok(read) = self.rpc("thread/read", json!({"threadId":id,"includeTurns":false}))
                else {
                    continue;
                };
                let t = &read["thread"];
                let Some(cwd) = t["cwd"].as_str() else {
                    continue;
                };
                if t["id"] == id
                    && (t["source"] == "cli" || t["originator"] == "codex-tui")
                    && t["parentThreadId"].is_null()
                    && t["status"]["type"] == "idle"
                {
                    let label = format!(
                        "Codex · {} · {} · live server",
                        t["name"].as_str().unwrap_or("Terminal"),
                        &id[..8]
                    );
                    out.push(make("codex-server", id, cwd, &label));
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        Ok((found, out))
    }
    pub(super) fn send(&mut self, t: &Value, msg: &str) -> Result<()> {
        let id = string(t, "block")?
            .strip_prefix("codex-server:")
            .context("Invalid thread")?;
        let turn = self.call(
            "turn/start",
            json!({"threadId":id,"input":[{"type":"text","text":msg}]}),
        );
        // Only an answer from Codex settles it. Silence after the request left is uncertain.
        let check = "Delivery is uncertain: Codex did not confirm the turn. Check that Codex \
                     thread before sending again.";
        match uncertain(turn, check)? {
            Reply::Result(_) => Ok(()),
            Reply::Declined => bail!(
                "Codex declined the turn, so nothing was delivered. Refresh destinations and \
                 send again."
            ),
        }
    }
}
