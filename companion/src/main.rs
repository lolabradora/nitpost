use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

mod agents;
mod rex;
mod setup;

fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(
        env::var_os("HOME").context("Missing home directory")?,
    ))
}
fn support() -> Result<PathBuf> {
    Ok(home()?.join("Library/Application Support/PaneParcel"))
}
fn string<'a>(obj: &'a Value, key: &str) -> Result<&'a str> {
    obj[key].as_str().with_context(|| format!("Missing {key}"))
}
fn list(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn project(v: &Value) -> Result<String> {
    let path = Path::new(string(v, "project")?);
    ensure!(
        path.is_absolute() && path.is_dir(),
        "Choose an existing project folder."
    );
    Ok(path.canonicalize()?.to_string_lossy().into_owned())
}
fn executable(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    env::split_paths(&env::var_os("PATH")?)
        .filter(|p| p.is_absolute())
        .map(|p| p.join(name))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}
// Spool both directions so a full pipe can never prevent a timeout.
fn run(program: &str, args: &[&str], input: &str, timeout: u64) -> Result<String> {
    let mut stdin = tempfile::tempfile()?;
    stdin.write_all(input.as_bytes())?;
    stdin.rewind()?;
    let mut out = tempfile::tempfile()?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(stdin)
        .stdout(out.try_clone()?)
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("Could not run {program}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            ensure!(
                status.success() || (program == "/usr/sbin/lsof" && status.code() == Some(1)),
                "{program} declined the request."
            );
            break;
        }
        if start.elapsed() >= Duration::from_secs(timeout) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{program} timed out.")
        }
        thread::sleep(Duration::from_millis(20));
    }
    ensure!(
        out.metadata()?.len() < 8 * 1024 * 1024,
        "Oversized response from {program}"
    );
    out.rewind()?;
    let mut result = String::new();
    out.read_to_string(&mut result)?;
    Ok(result)
}
fn batch(r: &Value) -> Result<String> {
    let page = string(r, "page")?;
    ensure!(
        page.len() <= 65536
            && (page.starts_with("file:///")
                || ["https://", "http://"].iter().any(|s| page
                    .strip_prefix(s)
                    .is_some_and(|v| !v.is_empty() && !v.starts_with('/')))),
        "Invalid page URL."
    );
    let notes = r["notes"].as_array().context("Missing notes")?;
    ensure!((1..=50).contains(&notes.len()), "Choose 1–50 notes.");
    let mut clean = vec![];
    for n in notes {
        let mut item = json!({});
        for (key, max) in [("comment", 2000), ("selector", 2048), ("text", 1000)] {
            let s = string(n, key)?;
            ensure!(
                s.chars().count() <= max && (key == "text" || !s.trim().is_empty()),
                "Invalid {key}."
            );
            item[key] = json!(s);
        }
        for key in ["width", "height"] {
            ensure!(
                n[key].as_u64().is_some_and(|v| (1..=100000).contains(&v)),
                "Invalid viewport."
            );
        }
        item["viewport"] = json!(format!("{}x{}", n["width"], n["height"]));
        clean.push(item);
    }
    let mut body = String::new();
    for c in json!({"page":page,"notes":clean}).to_string().chars() {
        if c == '\'' || c == '!' || c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
            body.push_str(&format!("\\u{:04x}", c as u32));
        } else {
            body.push(c);
        }
    }
    Ok(format!("Web annotations from PaneParcel: '{body}'"))
}
fn dispatch(r: Value) -> Result<Value> {
    match string(&r, "op")? {
        "targets" => {
            let mut targets = rex::targets();
            targets.extend(agents::targets()?.into_iter().map(agents::public));
            let starts: Vec<_> = ["codex", "claude"]
                .into_iter()
                .filter(|a| executable("rex").is_some() && executable(a).is_some())
                .collect();
            Ok(json!({"ok":true,"targets":targets,"starts":starts}))
        }
        "send" => {
            let msg = batch(&r)?;
            if agents::is_agent(&r) {
                return agents::send(&r, &msg);
            }
            rex::send(&r, &msg)?;
            Ok(json!({"ok":true}))
        }
        "focus" => {
            if agents::is_agent(&r) {
                agents::focus(&r)?
            } else {
                rex::focus(&r)?
            }
            Ok(json!({"ok":true}))
        }
        "start" => Ok(json!({"ok":true,"target":rex::start(&r,&batch(&r)?)?})),
        "chooseFolder" => {
            let choice=run("/usr/bin/osascript",&["-e","activate\ntry\nreturn POSIX path of (choose folder with prompt \"Choose a project folder for PaneParcel\")\non error number -128\nreturn \"\"\nend try"],"",300)?;
            let p = choice.trim_end_matches('\n');
            Ok(
                json!({"ok":true,"project":if p.is_empty(){None}else{Some(project(&json!({"project":p}))?)}}),
            )
        }
        _ => bail!("Unknown native request."),
    }
}
fn receive() -> Result<Value> {
    let mut input = io::stdin().lock();
    let mut header = [0; 4];
    input.read_exact(&mut header)?;
    let len = u32::from_ne_bytes(header) as usize;
    ensure!((1..=2097152).contains(&len), "Invalid native frame length.");
    let mut body = vec![0; len];
    input.read_exact(&mut body)?;
    dispatch(serde_json::from_slice(&body)?)
}
fn main() -> Result<()> {
    if env::args().nth(1).as_deref() == Some("register") {
        return setup::register();
    }
    setup::environment()?;
    let mut data = serde_json::to_vec(
        &receive().unwrap_or_else(|e| json!({"ok":false,"error":e.to_string()})),
    )?;
    if data.len() > 1024 * 1024 {
        data = br#"{"ok":false,"error":"Too many destinations."}"#.to_vec();
    }
    let mut out = io::stdout().lock();
    out.write_all(&(data.len() as u32).to_ne_bytes())?;
    out.write_all(&data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annotations_are_one_shell_quoted_argument_without_terminal_controls() {
        let r = json!({"page":"https://example.test","notes":[{"width":400,"height":300,"text":"Ω","selector":"input","comment":"'!\n\u{1b}\u{85}\u{2028}"}]});
        let msg = batch(&r).unwrap();
        assert_eq!(msg.chars().filter(|c| *c == '\'').count(), 2);
        assert!(!msg.chars().any(char::is_control));
        assert!(msg.contains("Ω"));
        assert!(msg.contains("400x300"));
    }
    #[test]
    fn local_html_is_delivered_with_its_url() {
        let mut r = json!({"page":"file:///tmp/project/index.html","notes":[{"width":640,"height":480,"text":"Local", "selector":"h1","comment":"Update heading"}]});
        assert!(batch(&r)
            .unwrap()
            .contains("file:///tmp/project/index.html"));
        r["page"] = json!("file://another-host/project/index.html");
        assert!(batch(&r).is_err());
    }
    #[test]
    fn uuid_must_be_complete_before_use_as_a_selector() {
        assert!(uuid("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(!uuid("focused"));
        assert!(!uuid("01234567-89ab-cdef-0123-456789abcde'"));
    }
}
