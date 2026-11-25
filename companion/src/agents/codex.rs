use super::*;
use tungstenite::{Message, WebSocket};
pub(super) fn directory() -> Result<PathBuf> {
    Ok(env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".codex")))
}
pub(super) struct Server {
    socket: WebSocket<UnixStream>,
    id: u64,
}
impl Server {
    pub(super) fn connect() -> Result<Self> {
        let path = env::var_os("PANEPARCEL_CODEX_SOCKET")
            .map(PathBuf::from)
            .unwrap_or(directory()?.join("app-server-control/app-server-control.sock"));
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
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        self.write(json!({"method":method,"params":params,"id":self.id}))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Message::Text(text) = self.socket.read()? {
                let v: Value = serde_json::from_str(&text)?;
                if v["id"] == self.id {
                    ensure!(
                        v.get("result").is_some(),
                        "Codex declined {method}. Check the selected terminal."
                    );
                    return Ok(v["result"].clone());
                }
            }
        }
        bail!("Codex response timed out.")
    }
    pub(super) fn targets(&mut self) -> Result<Vec<Value>> {
        let mut out = vec![];
        let mut cursor = Value::Null;
        loop {
            let page = self.rpc("thread/loaded/list", json!({"cursor":cursor,"limit":100}))?;
            for id in list(&page["data"]).filter_map(|id| id.as_str().filter(|s| uuid(s))) {
                let Ok(read) = self.rpc("thread/read", json!({"threadId":id,"includeTurns":false}))
                else {
                    continue;
                };
                let t = &read["thread"];
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
                    out.push(make("codex-server", id, string(t, "cwd")?, &label));
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        Ok(out)
    }
    pub(super) fn send(&mut self, t: &Value, msg: &str) -> Result<()> {
        let id = string(t, "block")?
            .strip_prefix("codex-server:")
            .context("Invalid thread")?;
        self.rpc(
            "turn/start",
            json!({"threadId":id,"input":[{"type":"text","text":msg}]}),
        )
        .context("Codex did not confirm the turn. Inspect its original UI before retrying.")?;
        Ok(())
    }
}
