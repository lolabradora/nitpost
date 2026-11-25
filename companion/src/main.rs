use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    env, fmt, fs,
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
// A failure after which the agent may already hold the batch. A failure without this marker
// happened before any byte could reach the agent.
#[derive(Debug)]
struct Uncertain(&'static str);
impl fmt::Display for Uncertain {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(self.0)
    }
}
// The command never ran, so it cannot have delivered anything.
#[derive(Debug)]
struct Unstarted(String);
impl fmt::Display for Unstarted {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Could not run {}.", self.0)
    }
}
fn uncertain<T>(result: Result<T>, check: &'static str) -> Result<T> {
    result.map_err(|e| e.context(Uncertain(check)))
}
// For the command that hands the batch over: uncertain unless that command never ran.
fn uncertain_once_started<T>(result: Result<T>, check: &'static str) -> Result<T> {
    match result {
        Err(e) if e.downcast_ref::<Unstarted>().is_none() => Err(e.context(Uncertain(check))),
        other => other,
    }
}
// A failed delivery always states its certainty. The extension reads a missing flag as
// uncertain, because helpers released before the flag reported uncertainty in words only.
fn failure(e: &anyhow::Error, delivery: bool) -> Value {
    let mut reply = json!({"ok":false,"error":e.to_string()});
    if delivery {
        reply["uncertain"] = json!(e.downcast_ref::<Uncertain>().is_some());
    }
    reply
}
// receipt: "confirmed" when the agent acknowledged the batch, "submitted" when it was typed
// or launched without an acknowledgement, "unconfirmed" when it was only handed over.
fn delivered(receipt: &str, notice: &str) -> Value {
    json!({"ok":true,"receipt":receipt,"notice":notice})
}
// What one route found: its destinations, how many candidates it saw, and one sentence the
// user can act on. The sentence never names a socket, PID or TTY.
struct Discovery {
    targets: Vec<Value>,
    found: usize,
    detail: String,
}
impl Discovery {
    fn none(detail: &str) -> Self {
        Self {
            targets: vec![],
            found: 0,
            detail: detail.into(),
        }
    }
    fn check(&self, route: &str) -> Value {
        json!({"route":route,"found":self.found,"eligible":self.targets.len(),"detail":self.detail})
    }
}
fn count(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
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
        .map_err(|e| anyhow::Error::new(e).context(Unstarted(program.into())))?;
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
// The extension caps each image well below this. Fifty notes with both kinds fit one native frame.
const MAX_IMAGE_CHARS: usize = 262_144;
const MAX_FRAME: usize = 16 * 1024 * 1024;
const SHOT_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);
// Document coordinates are signed: a right-to-left page scrolls into negative x.
const MAX_OFFSET: i64 = 100_000_000;

fn shots_dir() -> Result<PathBuf> {
    Ok(home()?.join("Library/Caches/com.micovi.paneparcel/shots"))
}
fn decode_base64(text: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    let (mut buffer, mut bits) = (0u32, 0u8);
    for c in text.trim_end_matches('=').bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => bail!("Invalid base64."),
        };
        buffer = (buffer << 6 | u32::from(value)) & 0xffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    Ok(bytes)
}
fn decode_image(data: &Value, what: &str) -> Result<Vec<u8>> {
    let invalid = || format!("Invalid {what}.");
    let data = data.as_str().with_context(invalid)?;
    ensure!(data.len() <= MAX_IMAGE_CHARS, "The {what} is too large.");
    let encoded = data
        .strip_prefix("data:image/jpeg;base64,")
        .with_context(invalid)?;
    let bytes = decode_base64(encoded).with_context(invalid)?;
    ensure!(bytes.starts_with(&[0xff, 0xd8, 0xff]), "Invalid {what}.");
    Ok(bytes)
}
// Agents open an image by path. Keep it private to this user. Every name starts with
// "note-" so the pruner removes it after seven days.
fn save_image(dir: &Path, prefix: &str, bytes: &[u8]) -> Result<String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let mut file = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(".jpg")
        .tempfile_in(dir)?;
    file.write_all(bytes)?;
    let (_, path) = file.keep()?;
    Ok(path.to_str().context("Invalid image path.")?.to_owned())
}
// Runs on every invocation. An unreadable directory must never fail the request.
fn prune_shots(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let ours = name
            .to_str()
            .is_some_and(|n| n.starts_with("note-") && n.ends_with(".jpg"));
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > SHOT_LIFETIME));
        if ours && old {
            // A screenshot another process already removed needs no further action.
            let _ = fs::remove_file(entry.path());
        }
    }
}
fn field<'a>(v: &'a Value, key: &str, max: usize, required: bool) -> Result<&'a str> {
    let s = string(v, key)?;
    ensure!(
        s.chars().count() <= max && !(required && s.trim().is_empty()),
        "Invalid {key}."
    );
    Ok(s)
}
fn element(v: &Value) -> Result<Value> {
    Ok(json!({"selector":field(v, "selector", 2048, true)?,"text":field(v, "text", 1000, false)?}))
}
fn rect(v: &Value) -> Result<Value> {
    let offset = |key: &str| {
        v[key]
            .as_i64()
            .filter(|n| (-MAX_OFFSET..=MAX_OFFSET).contains(n))
    };
    let size = |key: &str| v[key].as_u64().filter(|n| (1..=100_000).contains(n));
    let (Some(x), Some(y), Some(width), Some(height)) =
        (offset("x"), offset("y"), size("width"), size("height"))
    else {
        bail!("Invalid area.")
    };
    Ok(json!({"x":x,"y":y,"width":width,"height":height}))
}
// Returns the heading that names what the user selected, and its details. Each scope is
// rebuilt from its own fields only: an area is a rectangle and never gains a selector.
fn selection(n: &Value) -> Result<(&'static str, Value)> {
    let scope = if n["scope"].is_null() {
        "element"
    } else {
        string(n, "scope")?
    };
    let carries = |keys: &[&str]| keys.iter().any(|k| !n[*k].is_null());
    match scope {
        "element" => {
            ensure!(
                !carries(&["rect", "elements"]),
                "An element note cannot carry an area or a list of elements."
            );
            Ok(("Selected element", element(n)?))
        }
        "area" => {
            ensure!(
                !carries(&["selector", "text", "elements"]),
                "An area note cannot carry a selector, text or elements."
            );
            Ok(("Selected area", json!({"rect":rect(&n["rect"])?})))
        }
        "group" => {
            ensure!(
                !carries(&["selector", "text", "rect"]),
                "A group note lists its elements and cannot carry a selector, text or area."
            );
            let items = n["elements"].as_array().context("Missing elements")?;
            ensure!(
                (2..=8).contains(&items.len()),
                "A group note needs 2–8 elements."
            );
            let elements = items.iter().map(element).collect::<Result<Vec<_>>>()?;
            Ok(("Selected elements", json!({"elements":elements})))
        }
        _ => bail!("Invalid scope."),
    }
}
const GUIDE: &str = "change: edit the code. question: answer without editing. \
screenshot: local JPEG of the selection as the page looks now. \
Reference image: local JPEG supplied by the user that shows the result they want; \
it was not taken from the page. \
Selected area: a page region with no element selected; rect is in CSS pixels from \
the top-left of the document. \
Selected elements: several elements that share one note.";

// A batch that passed validation. Its images are still in memory: they are written only
// once the destination is known to be there, so a send that cannot be delivered leaves
// nothing on disk.
struct Batch {
    page: String,
    notes: Vec<Value>,
    images: Vec<(usize, Option<&'static str>, Vec<u8>)>,
}
impl Batch {
    fn message(self) -> Result<String> {
        self.write(&shots_dir()?)
    }
    fn write(mut self, shots: &Path) -> Result<String> {
        for (index, heading, bytes) in self.images {
            let note = &mut self.notes[index];
            match heading {
                Some(heading) => {
                    note[heading]["screenshot"] = json!(save_image(shots, "note-", &bytes)?)
                }
                None => {
                    note["Reference image"] = json!(save_image(shots, "note-reference-", &bytes)?)
                }
            }
        }
        let mut body = String::new();
        for c in json!({"Source page":self.page,"kinds":GUIDE,"notes":self.notes})
            .to_string()
            .chars()
        {
            if c == '\'' || c == '!' || c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                body.push_str(&format!("\\u{:04x}", c as u32));
            } else {
                body.push(c);
            }
        }
        Ok(format!("Web annotations from PaneParcel: '{body}'"))
    }
}
fn batch(r: &Value) -> Result<Batch> {
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
    let mut images = vec![];
    for n in notes {
        let kind = n["kind"].as_str().unwrap_or("change");
        ensure!(["change", "question"].contains(&kind), "Invalid kind.");
        let mut item = json!({"kind":kind,"User note":field(n, "comment", 2000, true)?});
        let (heading, mut detail) = selection(n)?;
        for key in ["width", "height"] {
            ensure!(
                n[key].as_u64().is_some_and(|v| (1..=100000).contains(&v)),
                "Invalid viewport."
            );
        }
        detail["viewport"] = json!(format!("{}x{}", n["width"], n["height"]));
        item[heading] = detail;
        if !n["image"].is_null() {
            let bytes = decode_image(&n["image"], "screenshot")?;
            images.push((clean.len(), Some(heading), bytes));
        }
        if !n["reference"].is_null() {
            let bytes = decode_image(&n["reference"], "reference image")?;
            images.push((clean.len(), None, bytes));
        }
        clean.push(item);
    }
    Ok(Batch {
        page: page.into(),
        notes: clean,
        images,
    })
}
fn dispatch(r: Value) -> Result<Value> {
    match string(&r, "op")? {
        "targets" => {
            let rex = rex::discover();
            let [claude, codex, tmux] = agents::discover();
            let checks = [
                claude.check("claude"),
                codex.check("codex"),
                tmux.check("tmux"),
                rex.check("rex"),
            ];
            let mut targets = rex.targets;
            for route in [claude, codex, tmux] {
                targets.extend(route.targets.into_iter().map(agents::public));
            }
            let starts: Vec<_> = ["codex", "claude"]
                .into_iter()
                .filter(|a| executable("rex").is_some() && executable(a).is_some())
                .collect();
            Ok(json!({"ok":true,"targets":targets,"starts":starts,"checks":checks}))
        }
        "capabilities" => Ok(json!({"ok":true,"shots":true,"payload":2})),
        "send" => {
            let batch = batch(&r)?;
            if agents::is_agent(&r) {
                return agents::send(&r, batch);
            }
            rex::send(&r, batch)?;
            Ok(delivered(
                "submitted",
                "Pasted into the selected Rex pane and pressed Enter. The pane sends no receipt.",
            ))
        }
        "start" => {
            let target = rex::start(&r, batch(&r)?)?;
            let mut reply = delivered(
                "submitted",
                "Started a new Rex session with these notes as its first prompt. \
                 The agent sends no receipt.",
            );
            reply["target"] = target;
            Ok(reply)
        }
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
    ensure!(
        (1..=MAX_FRAME).contains(&len),
        "Invalid native frame length."
    );
    let mut body = vec![0; len];
    input.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}
fn answer(request: Value) -> Value {
    let delivery = matches!(request["op"].as_str(), Some("send" | "start"));
    dispatch(request).unwrap_or_else(|e| failure(&e, delivery))
}
fn main() -> Result<()> {
    if env::args().nth(1).as_deref() == Some("register") {
        return setup::register();
    }
    setup::environment()?;
    if let Ok(dir) = shots_dir() {
        prune_shots(&dir);
    }
    let reply = receive().map_or_else(|e| failure(&e, false), answer);
    let mut data = serde_json::to_vec(&reply)?;
    // Only a destination list can grow this large. Chrome drops a reply over 1 MiB.
    if data.len() > 1024 * 1024 {
        data = br#"{"ok":false,"error":"Too many destinations to list. Close agent sessions you are not using, then refresh destinations."}"#.to_vec();
    }
    let mut out = io::stdout().lock();
    out.write_all(&(data.len() as u32).to_ne_bytes())?;
    out.write_all(&data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // "/9j/4A==" is the JPEG signature FF D8 FF E0.
    const JPEG: &str = "data:image/jpeg;base64,/9j/4A==";
    fn page(notes: Value) -> Value {
        json!({"page":"https://example.test","notes":notes})
    }
    fn element() -> Value {
        json!({"width":400,"height":300,"text":"","selector":"h1","comment":"Fix"})
    }
    fn area() -> Value {
        json!({"scope":"area","width":400,"height":300,"comment":"Reduce this gap",
            "rect":{"x":12,"y":3400,"width":320,"height":48}})
    }
    fn group() -> Value {
        json!({"scope":"group","width":400,"height":300,"comment":"Align these",
            "elements":[{"selector":"h1","text":"One"},{"selector":"h2","text":""}]})
    }
    // Rendering in a throwaway directory keeps tests away from the real cache.
    fn message(r: &Value) -> Result<String> {
        render(r, tempfile::tempdir()?.path())
    }
    fn render(r: &Value, shots: &Path) -> Result<String> {
        batch(r)?.write(shots)
    }
    fn parsed(msg: &str) -> Value {
        let words = shlex::split(msg).unwrap();
        assert_eq!(words[..4], ["Web", "annotations", "from", "PaneParcel:"]);
        assert_eq!(words.len(), 5, "the batch must stay one shell argument");
        serde_json::from_str(&words[4]).unwrap()
    }
    fn files(dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return vec![];
        };
        let mut names: Vec<_> = entries
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }
    #[test]
    fn annotations_are_one_shell_quoted_argument_without_terminal_controls() {
        let hostile = "'!\n\u{1b}\u{85}\u{2028}`$(id)`; #";
        let mut grouped = group();
        grouped["comment"] = json!(hostile);
        grouped["elements"][0] = json!({"selector":hostile,"text":hostile});
        grouped["reference"] = json!(JPEG);
        let mut region = area();
        region["comment"] = json!(hostile);
        let r = page(json!([
            {"width":400,"height":300,"text":"Ω","selector":"input","comment":hostile},
            region,
            grouped
        ]));
        let msg = message(&r).unwrap();
        assert_eq!(msg.chars().filter(|c| *c == '\'').count(), 2);
        assert!(!msg.chars().any(char::is_control));
        assert!(!msg.contains('!') && !msg.contains('\u{2028}'));
        assert!(msg.contains("Ω"));
        let batch = parsed(&msg);
        assert_eq!(batch["Source page"], r["page"]);
        assert_eq!(batch["notes"][0]["User note"], hostile);
        assert_eq!(
            batch["notes"][0]["Selected element"],
            json!({"text":"Ω","selector":"input","viewport":"400x300"})
        );
        assert_eq!(batch["notes"][1]["User note"], hostile);
        assert_eq!(
            batch["notes"][2]["Selected elements"]["elements"][0],
            json!({"selector":hostile,"text":hostile})
        );
    }
    #[test]
    fn local_html_is_delivered_with_its_url() {
        let mut r = page(json!([element()]));
        r["page"] = json!("file:///tmp/project/index.html");
        assert!(message(&r)
            .unwrap()
            .contains("file:///tmp/project/index.html"));
        r["page"] = json!("file://another-host/project/index.html");
        assert!(message(&r).is_err());
    }
    #[test]
    fn notes_state_their_kind_and_default_to_change() {
        let mut question = element();
        question["kind"] = json!("question");
        let mut r = page(json!([question, element()]));
        let msg = message(&r).unwrap();
        assert!(msg.contains(r#""kind":"question""#) && msg.contains(r#""kind":"change""#));
        assert!(msg.contains("answer without editing"));
        r["notes"][0]["kind"] = json!("praise");
        assert!(message(&r).is_err());
    }
    #[test]
    fn the_guide_tells_the_current_page_from_the_desired_result() {
        let guide = parsed(&message(&page(json!([element()]))).unwrap())["kinds"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(guide.contains("screenshot: local JPEG of the selection as the page looks now"));
        assert!(guide.contains("Reference image: local JPEG supplied by the user"));
        assert!(guide.contains("not taken from the page"));
        assert!(guide.contains("Selected area: a page region with no element selected"));
        assert!(guide.contains("CSS pixels from the top-left of the document"));
    }
    #[test]
    fn an_area_is_a_rectangle_and_never_has_a_selector() {
        let dir = tempfile::tempdir().unwrap();
        let mut note = area();
        note["image"] = json!(JPEG);
        let msg = render(&page(json!([note])), dir.path()).unwrap();
        assert!(!msg.contains("selector"));
        let batch = parsed(&msg);
        let rendered = &batch["notes"][0];
        let shot = rendered["Selected area"]["screenshot"].as_str().unwrap();
        assert!(Path::new(shot).is_file());
        assert_eq!(
            rendered["Selected area"],
            json!({"rect":{"x":12,"y":3400,"width":320,"height":48},"viewport":"400x300",
                "screenshot":shot})
        );
        assert!(rendered.get("Selected element").is_none());
        // A right-to-left page scrolls into negative document coordinates.
        let mut rtl = area();
        rtl["rect"]["x"] = json!(-250);
        assert!(message(&page(json!([rtl]))).is_ok());
        for (key, value) in [
            ("selector", json!("div.gap")),
            ("selector", json!("")),
            ("text", json!("Gap")),
            (
                "elements",
                json!([{"selector":"a","text":""},{"selector":"b","text":""}]),
            ),
        ] {
            let mut bad = area();
            bad[key] = value;
            assert!(message(&page(json!([bad]))).is_err(), "{key}");
        }
        for rect in [
            json!(null),
            json!("12,3400,320,48"),
            json!({"x":12,"y":3400,"width":320}),
            json!({"x":12.5,"y":3400,"width":320,"height":48}),
            json!({"x":12,"y":3400,"width":0,"height":48}),
            json!({"x":12,"y":3400,"width":320,"height":-48}),
            json!({"x":12,"y":3400,"width":320,"height":100_001}),
            json!({"x":12,"y":MAX_OFFSET + 1,"width":320,"height":48}),
        ] {
            let mut bad = area();
            bad["rect"] = rect.clone();
            assert!(message(&page(json!([bad]))).is_err(), "{rect}");
        }
    }
    #[test]
    fn a_group_lists_two_to_eight_elements_under_one_note() {
        let batch = parsed(&message(&page(json!([group()]))).unwrap());
        assert_eq!(
            batch["notes"][0],
            json!({"kind":"change","User note":"Align these","Selected elements":{
                "elements":[{"selector":"h1","text":"One"},{"selector":"h2","text":""}],
                "viewport":"400x300"}})
        );
        let item = json!({"selector":"li","text":""});
        for (size, accepted) in [(0, false), (1, false), (2, true), (8, true), (9, false)] {
            let mut note = group();
            note["elements"] = json!(vec![item.clone(); size]);
            assert_eq!(message(&page(json!([note]))).is_ok(), accepted, "{size}");
        }
        for elements in [
            json!(null),
            json!("h1,h2"),
            json!([{"selector":"h1","text":""},{"text":""}]),
            json!([{"selector":"h1","text":""},{"selector":" ","text":""}]),
            json!([{"selector":"h1","text":""},{"selector":"h2"}]),
            json!([{"selector":"h1","text":""},"h2"]),
        ] {
            let mut bad = group();
            bad["elements"] = elements.clone();
            assert!(message(&page(json!([bad]))).is_err(), "{elements}");
        }
        for (key, value) in [
            ("selector", json!("h1")),
            ("text", json!("One")),
            ("rect", area()["rect"].clone()),
        ] {
            let mut bad = group();
            bad[key] = value;
            assert!(message(&page(json!([bad]))).is_err(), "{key}");
        }
    }
    #[test]
    fn the_scope_decides_which_fields_a_note_may_carry() {
        let mut explicit = element();
        explicit["scope"] = json!("element");
        let batch = parsed(&message(&page(json!([explicit]))).unwrap());
        assert_eq!(batch["notes"][0]["Selected element"]["selector"], "h1");
        for (key, value) in [
            ("scope", json!("page")),
            ("scope", json!(2)),
            ("rect", area()["rect"].clone()),
            ("elements", group()["elements"].clone()),
        ] {
            let mut bad = element();
            bad[key] = value;
            assert!(message(&page(json!([bad]))).is_err(), "{key}");
        }
    }
    #[test]
    fn screenshots_become_private_files_named_in_the_message() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join("shots");
        let mut note = element();
        note["image"] = json!(JPEG);
        let mut r = page(json!([note]));
        let msg = render(&r, &shots).unwrap();
        let file = shots.join(&files(&shots)[0]);
        assert_eq!(fs::read(&file).unwrap(), [0xff, 0xd8, 0xff, 0xe0]);
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            shots.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(msg.contains(&format!(r#""screenshot":"{}""#, file.display())));
        assert!(!msg.contains("base64"));
        let oversized = format!("data:image/jpeg;base64,{}", "A".repeat(MAX_IMAGE_CHARS));
        for key in ["image", "reference"] {
            for bad in [
                json!("data:image/png;base64,/9j/4A=="),
                json!("data:image/jpeg;base64,AAAA"),
                json!("data:image/jpeg;base64,*"),
                json!(oversized),
                json!(7),
            ] {
                r["notes"][0]["image"] = json!(JPEG);
                r["notes"][0][key] = bad.clone();
                assert!(render(&r, &shots).is_err(), "{key} {bad}");
            }
            r["notes"][0][key] = Value::Null;
        }
        assert_eq!(files(&shots).len(), 1);
    }
    #[test]
    fn a_reference_image_is_kept_apart_from_the_screenshot() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join("shots");
        let mut with_both = element();
        with_both["image"] = json!(JPEG);
        with_both["reference"] = json!("data:image/jpeg;base64,/9j/2w==");
        let mut reference_only = area();
        reference_only["reference"] = json!(JPEG);
        let msg = render(&page(json!([with_both, reference_only, group()])), &shots).unwrap();
        let batch = parsed(&msg);
        let first = &batch["notes"][0];
        let reference = Path::new(first["Reference image"].as_str().unwrap());
        let shot = Path::new(first["Selected element"]["screenshot"].as_str().unwrap());
        assert_eq!(fs::read(reference).unwrap(), [0xff, 0xd8, 0xff, 0xdb]);
        assert_eq!(fs::read(shot).unwrap(), [0xff, 0xd8, 0xff, 0xe0]);
        assert_eq!(reference.parent(), Some(shots.as_path()));
        assert_eq!(
            reference.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        let name = reference.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("note-reference-") && name.ends_with(".jpg"));
        assert!(batch["notes"][1]["Reference image"].is_string());
        assert!(batch["notes"][1]["Selected area"]
            .get("screenshot")
            .is_none());
        assert!(batch["notes"][2].get("Reference image").is_none());
        assert_eq!(files(&shots).len(), 3);
    }
    #[test]
    fn no_image_is_written_when_a_later_note_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let mut good = element();
        good["image"] = json!(JPEG);
        good["reference"] = json!(JPEG);
        let mut bad = element();
        bad["reference"] = json!("data:image/jpeg;base64,AAAA");
        let error = render(&page(json!([good, bad])), dir.path()).unwrap_err();
        assert_eq!(error.to_string(), "Invalid reference image.");
        assert!(files(dir.path()).is_empty());
    }
    #[test]
    fn a_validated_batch_writes_nothing_until_its_message_is_built() {
        let dir = tempfile::tempdir().unwrap();
        let mut note = element();
        note["image"] = json!(JPEG);
        note["reference"] = json!(JPEG);
        let batch = batch(&page(json!([note]))).unwrap();
        assert!(files(dir.path()).is_empty());
        batch.write(dir.path()).unwrap();
        assert_eq!(files(dir.path()).len(), 2);
    }
    #[test]
    fn old_images_are_removed_and_other_files_kept() {
        let dir = tempfile::tempdir().unwrap();
        let expired = std::time::SystemTime::now() - SHOT_LIFETIME - Duration::from_secs(60);
        for name in ["note-old.jpg", "note-reference-old.jpg", "kept-old.png"] {
            let old = fs::File::create(dir.path().join(name)).unwrap();
            old.set_modified(expired).unwrap();
        }
        fs::write(dir.path().join("note-new.jpg"), "").unwrap();
        fs::write(dir.path().join("note-reference-new.jpg"), "").unwrap();
        fs::write(dir.path().join("delivery.lock"), "").unwrap();
        prune_shots(dir.path());
        assert_eq!(
            files(dir.path()),
            [
                "delivery.lock",
                "kept-old.png",
                "note-new.jpg",
                "note-reference-new.jpg"
            ]
        );
        // A missing or unreadable directory is not an error.
        prune_shots(&dir.path().join("absent"));
        prune_shots(&dir.path().join("delivery.lock"));
    }
    #[test]
    fn only_failures_after_delivery_may_have_started_are_uncertain() {
        let plain = anyhow::anyhow!("The selected conversation is unavailable.");
        assert_eq!(
            failure(&plain, true),
            json!({"ok":false,"error":"The selected conversation is unavailable.",
                "uncertain":false})
        );
        // Only send and start deliver, so only their failures carry the flag.
        assert_eq!(
            failure(&plain, false),
            json!({"ok":false,"error":"The selected conversation is unavailable."})
        );
        let late = uncertain(
            Err::<(), _>(anyhow::anyhow!("timed out")),
            "Check the pane.",
        )
        .context("while sending")
        .unwrap_err();
        assert_eq!(
            failure(&late, true),
            json!({"ok":false,"error":"while sending","uncertain":true})
        );
        let direct = uncertain(
            Err::<(), _>(anyhow::anyhow!("timed out")),
            "Check the pane.",
        );
        assert_eq!(
            failure(&direct.unwrap_err(), true),
            json!({"ok":false,"error":"Check the pane.","uncertain":true})
        );
    }
    #[test]
    fn a_command_that_never_ran_is_not_an_uncertain_delivery() {
        let missing = run("/nonexistent/paneparcel-test-tool", &[], "", 1);
        let reply = failure(
            &uncertain_once_started(missing, "Check the pane.").unwrap_err(),
            true,
        );
        assert_eq!(
            reply,
            json!({"ok":false,"error":"Could not run /nonexistent/paneparcel-test-tool.",
                "uncertain":false})
        );
        let refused = run("/usr/bin/false", &[], "", 5);
        let reply = failure(
            &uncertain_once_started(refused, "Check the pane.").unwrap_err(),
            true,
        );
        assert_eq!(
            reply,
            json!({"ok":false,"error":"Check the pane.","uncertain":true})
        );
        assert!(uncertain_once_started(Ok(()), "Check the pane.").is_ok());
    }
    #[test]
    fn a_check_reports_counts_and_one_sentence() {
        let none = Discovery::none("Rex is not running; open Rex to list its panes.");
        assert_eq!(
            none.check("rex"),
            json!({"route":"rex","found":0,"eligible":0,
                "detail":"Rex is not running; open Rex to list its panes."})
        );
        let some = Discovery {
            targets: vec![json!({})],
            found: 3,
            detail: count(1, "Codex thread"),
        };
        assert_eq!(
            some.check("codex"),
            json!({"route":"codex","found":3,"eligible":1,"detail":"1 Codex thread"})
        );
        assert_eq!(count(2, "Codex thread"), "2 Codex threads");
    }
    #[test]
    fn uuid_must_be_complete_before_use_as_a_selector() {
        assert!(uuid("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(!uuid("focused"));
        assert!(!uuid("01234567-89ab-cdef-0123-456789abcde'"));
    }
}
