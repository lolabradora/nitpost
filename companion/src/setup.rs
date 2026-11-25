use super::*;
use std::os::unix::fs::PermissionsExt;
use tempfile::NamedTempFile;
fn config() -> Result<Value> {
    match fs::read(support()?.join("settings.json")) {
        Ok(v) => Ok(serde_json::from_slice(&v)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
pub fn environment() -> Result<()> {
    let c = config()?;
    for k in [
        "PATH",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "PANEPARCEL_CODEX_SOCKET",
    ] {
        if let Some(v) = c[k].as_str() {
            env::set_var(k, v);
        }
    }
    Ok(())
}
pub fn extra_agents() -> Result<Vec<String>> {
    Ok(list(&config()?["agents"])
        .filter_map(|a| a.as_str().map(str::to_owned))
        .collect())
}
fn atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let dir = path.parent().context("Invalid install path")?;
    fs::create_dir_all(dir)?;
    let mut temp = NamedTempFile::new_in(dir)?;
    temp.write_all(bytes)?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(mode))?;
    temp.persist(path)?;
    Ok(())
}
// Copy nested assets as well as scripts. Publish the extension manifest last.
fn install_assets(source: &Path, destination: &Path, root: bool) -> Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if root && name == "manifest.json" {
            continue;
        }
        let kind = entry.file_type()?;
        let dest = destination.join(name);
        if kind.is_dir() {
            install_assets(&entry.path(), &dest, false)?;
        } else {
            ensure!(kind.is_file(), "Unexpected extension asset type.");
            atomic(&dest, &fs::read(entry.path())?, 0o600)?;
        }
    }
    if root {
        atomic(
            &destination.join("manifest.json"),
            &fs::read(source.join("manifest.json"))?,
            0o600,
        )?;
    }
    Ok(())
}
const NAME: &str = "com.micovi.paneparcel";
pub fn register() -> Result<()> {
    let root = support()?;
    fs::create_dir_all(&root)?;
    // A directory flock serializes install/update/uninstall without leaving a lock file.
    let guard = fs::File::open(&root)?;
    fs2::FileExt::lock_exclusive(&guard)?;
    let host = root.join("paneparcel");
    let legacy = root.join("launch");
    let manifest = home()?.join(format!(
        "Library/Application Support/Google/Chrome/NativeMessagingHosts/{NAME}.json"
    ));
    let old: Value = if manifest.exists() {
        serde_json::from_slice(&fs::read(&manifest)?)?
    } else {
        json!({})
    };
    if !old.is_null() && old.get("path").is_some() {
        ensure!(
            [host.to_str(), legacy.to_str()].contains(&old["path"].as_str()),
            "Existing host registration belongs to another installation."
        );
    }
    let mut args = env::args().skip(2);
    let mode = args.next().unwrap_or_default();
    if mode == "uninstall" {
        for path in [
            manifest,
            host,
            root.join("settings.json"),
            legacy,
            root.join("bridge.py"),
        ] {
            if path.is_file() {
                fs::remove_file(path)?;
            }
        }
        println!("Removed the companion. Chrome retains its extension and saved notes.");
        return Ok(());
    }
    ensure!(mode == "install", "Expected register install or uninstall.");
    let source = env::current_exe()?
        .parent()
        .context("Missing release directory")?
        .to_owned();
    let mut cfg = config()?;
    let mut agents = extra_agents()?;
    if !root.join("settings.json").exists() && legacy.is_file() {
        let script = fs::read_to_string(&legacy)?;
        if let Some(words) = script
            .lines()
            .find_map(|l| l.strip_prefix("exec ").and_then(shlex::split))
        {
            if let Some(i) = words
                .iter()
                .position(|s| Path::new(s) == root.join("bridge.py"))
            {
                agents.extend(words.into_iter().skip(i + 2));
            }
        }
    }
    let mut store_origin = None;
    let mut existing_extension = None;
    let mut replace = false;
    while let Some(flag) = args.next() {
        if flag == "--extension-id" {
            let id = args.next().context("Missing Chrome Web Store item ID")?;
            ensure!(
                id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)),
                "Invalid extension ID."
            );
            store_origin = Some(json!(format!("chrome-extension://{id}/")));
            continue;
        }
        if flag == "--extension-dir" {
            let directory = PathBuf::from(
                args.next()
                    .context("Missing existing extension directory")?,
            )
            .canonicalize()?;
            let old: Value = serde_json::from_slice(
                &fs::read(directory.join("manifest.json"))
                    .context("Choose the existing unpacked PaneParcel extension directory")?,
            )?;
            let new: Value =
                serde_json::from_slice(&fs::read(source.join("extension/manifest.json"))?)?;
            ensure!(
                new["key"].is_string() && old["key"] == new["key"],
                "This directory belongs to a different extension."
            );
            existing_extension = Some(directory);
            continue;
        }
        ensure!(flag == "--agent", "Unknown install option.");
        let a = args.next().context("Missing agent name")?;
        ensure!(
            !a.is_empty()
                && a.len() <= 80
                && a.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b)),
            "Invalid agent name."
        );
        if !replace {
            agents.clear();
            replace = true;
        }
        agents.push(a);
    }
    cfg["agents"] = json!(agents);
    let path = env::var_os("PATH").unwrap_or_default();
    cfg["PATH"] = json!(
        env::join_paths(env::split_paths(&path).filter(|p| p.is_absolute()))?
            .to_str()
            .context("Invalid PATH")?
    );
    for k in ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "PANEPARCEL_CODEX_SOCKET"] {
        if let Ok(path) = env::var(k) {
            ensure!(Path::new(&path).is_absolute(), "Expected absolute {k}");
            cfg[k] = json!(path);
        }
    }
    let origin = "chrome-extension://nbodoigokndfjagdocbaobppgepiflpf/";
    let origins = old["allowed_origins"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!(origin)]);
    ensure!(
        !origins.is_empty()
            && origins.iter().all(|v| v
                .as_str()
                .and_then(|s| s.strip_prefix("chrome-extension://"))
                .and_then(|s| s.strip_suffix('/'))
                .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b)))),
        "Invalid existing extension origin."
    );
    let mut origins = origins;
    if !origins.contains(&json!(origin)) {
        origins.push(json!(origin));
    }
    if let Some(store) = store_origin {
        if !origins.contains(&store) {
            origins.push(store);
        }
    }
    let registration = json!({"name":NAME,"description":"PaneParcel local companion","path":host,"type":"stdio","allowed_origins":origins});
    install_assets(&source.join("extension"), &root.join("extension"), true)?;
    if let Some(directory) = existing_extension {
        if directory != root.join("extension").canonicalize()? {
            install_assets(&source.join("extension"), &directory, true)?;
        }
    }
    atomic(
        &root.join("settings.json"),
        &serde_json::to_vec(&cfg)?,
        0o600,
    )?;
    atomic(&host, &fs::read(env::current_exe()?)?, 0o700)?;
    atomic(&manifest, &serde_json::to_vec_pretty(&registration)?, 0o600)?;
    println!("Registered PaneParcel. In chrome://extensions enable Developer mode, then Load unpacked and select:\n{}\nExisting users: reload your existing extension from its original updated folder to keep drafts.",root.join("extension").display());
    Ok(())
}
