# PaneParcel

Annotate a web page and send selected notes to an open local Codex CLI or Claude Code conversation. Pick the project and destination in Chrome. Rex is optional. Each note includes its comment, selector, text excerpt, viewport size and full page URL.

## Install the Apple Silicon beta

On an Apple Silicon Mac, run this in a terminal where your agent CLIs are on PATH.

```sh
curl -fsSL https://github.com/lolabradora/paneparcel/releases/download/v0.3.0-beta.1/install.sh | /bin/sh
```

The installer verifies the bundled archive against a pinned SHA-256, installs an Apple Silicon executable and extension under `~/Library/Application Support/PaneParcel`, and registers the host for the current Google Chrome user. Chrome starts one process per native request. A fresh install needs Chrome and an agent for your chosen destination. The package includes the compiled Rust program.

**Approve the extension in Chrome.** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, then press **⌘⇧G** in the folder dialog and enter `~/Library/Application Support/PaneParcel/extension`. Confirm the folder and allow site access on the pages you want to annotate. Pin PaneParcel in the Chrome toolbar and click its icon to start picking. For local HTML files, enable **Allow access to file URLs** in the extension details. A managed browser can require administrator approval. [Chrome unpacked-extension instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) · [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

**Upgrade an existing unpacked extension.** Keep the same Chrome entry and profile. If Chrome loads the installed extension under Application Support, run `sh install.sh`. If it loads a development checkout, run `sh install.sh --extension-dir "/absolute/path/to/your/existing/extension"` instead. This explicitly updates the extension files in that folder, including icons; it checks the manifest key first. Then click **Reload** on that extension at `chrome://extensions` and refresh any open annotated pages. Saved notes, recent projects and destinations stay under the same Chrome extension ID. The installer retains registered extension origins and custom Rex agents.

### Copyable coding-agent prompt

> Install the PaneParcel Apple Silicon beta on my Mac using the pinned GitHub Release command above and my normal CLI PATH. Verify the registered host and its extension ID, and tell me which folder to approve at chrome://extensions. If PaneParcel is already loaded, keep its existing extension entry, notes and preferences and explain how to reload it. Leave browser approvals to me. Do not send anything to my agent conversations.

### Update or uninstall

Install the next release from its checkout or release installer using the same command, then reload the extension and tabs. Installation captures absolute PATH entries and explicitly set `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `PANEPARCEL_CODEX_SOCKET`. Run the installer again after moving a CLI. For Rex custom agents, use `sh install.sh --agent opencode`. Repeat the flag to replace the custom list.

Remove the companion and native registration with this command. The extension and its local notes remain available.

```sh
"$HOME/Library/Application Support/PaneParcel/paneparcel" register uninstall
```

For complete removal, remove PaneParcel in Chrome when you are finished with its drafts, then delete the installed PaneParcel folder. The installer never edits the Chrome profile database, agent configuration or transcripts.

## Choose a conversation

Save one or more notes, choose **Project**, then choose **Conversation**. Refresh the picker after opening, closing or switching sessions. The short thread ID or Rex tab/pane label distinguishes conversations in the same folder. Saved destinations are scoped to a site, or to a single GitHub repository. Background actions leave Chrome in front where the terminal supports it. Focus runs after submission. Inspect the destination before retrying any uncertain delivery.

| Destination in picker | Prerequisites and semantics | Original UI and focus |
| --- | --- | --- |
| Claude Code peer inbox | Local interactive session with a live inbox and matching session record. Discovery uses `claude agents --json`; the host checks the socket peer PID before posting. Works for sessions independently opened in an ordinary terminal. | Original Claude UI shows a peer message when accepted. Inbound settings can hold or drop it. Socket submission has no receipt, so notes stay saved. Verify, then remove them. Focus is offered for a recognized Terminal.app or iTerm2 tab. |
| Codex live server | Idle top-level CLI thread loaded in its owning local app server. Uses the existing default Unix socket, or an absolute `PANEPARCEL_CODEX_SOCKET` set when installing. Sends `turn/start` for that exact thread. | An attached TUI showed the new turn live. A loaded thread can outlive its UI. Background only. Busy threads are omitted from this route. |
| Codex tmux | Standalone foreground Codex in a discoverable tmux pane. Needs tmux on PATH, a saved CLI thread, exactly one open thread writer lock for the PID, and an empty, ready agent prompt. Copy mode and synchronized panes are excluded. | Bracketed paste followed by Enter in the original pane. Background only. The helper uses tmux’s default server. |
| Codex Terminal.app / iTerm2 Automation (preview) | Standalone foreground Codex, same thread/PID checks, matching terminal ancestry and tab TTY. macOS may ask permission to control that terminal under **Privacy & Security → Automation**. Use an empty, ready agent prompt. | Targets that tab for input and optional focus. GUI compatibility still needs verification on a Mac with Automation approval. |
| Codex deferred queue | Standalone foreground owner with a saved CLI thread and a CLI advertising `codex queue`. Includes ordinary terminals with no tab-control integration. | **Queue for later** uses the exact UUID, without `--resume`. CLI acceptance confirms a stored submission. The independently running fixture did not show it during observation. |
| Rex pane | Running Rex and a recognized foreground agent in a chosen pane. Select a ready, empty prompt. | Existing paste/Enter and optional session, tab and pane focus. Explicit **New … session** launches the selected CLI with the batch as its initial prompt in the selected folder. |

Rex and terminal-input routes address a foreground pane. Finish sign-in, trust and approval dialogs first, and refresh after using an in-terminal conversation switcher.

Standalone Codex discovery reads version-dependent local writer-lock, TUI marker and thread metadata. A fresh thread may need its first user turn before it appears. Unsupported metadata, ambiguous owners, archived sessions and foreground shells are omitted. Claude uses a version-dependent PID record to associate the official listing with its documented Unix inbox. `--bare` Claude sessions lack an inbox. Detached jobs are eligible only when the CLI supplies a live PID and matching per-session socket. The picker has no routes to cloud, SSH-only or other-account stores. Choosing a saved project alone never selects a new target.

PaneParcel does not resume or fork sessions, edit history, approve agent prompts, start a daemon for discovery or silently fall back from one delivery mechanism to another. Codex also offers `resume` and `fork`, and Claude offers `--resume`, `--fork-session` and `attach`. These have different ownership and UI behavior. Claude’s `--input-format stream-json` is input for a print-mode process a caller starts. Claude cross-session inboxes use the recipient’s permission policy. [Codex app-server protocol](https://developers.openai.com/codex/app-server/) · [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) · [Claude session listings](https://code.claude.com/docs/en/agent-view) · [Claude peer inbox and inbound controls](https://code.claude.com/docs/en/cross-session-messaging)

## Notes and privacy

Drafts belong to the exact page URL. The last 12 project folders are available across sites. Sending shares the URL including query and fragment, selected element context and comments with the chosen agent, which uses its configured provider. Some terminal routes and new-session prompts use command arguments visible to local process inspection. Use the picker in the top-level document. Keyboard users can activate PaneParcel from the Chrome toolbar, select a focusable element with Enter, save with ⌘/Ctrl + Enter or cancel with Escape.

## Verification and release

The macOS fixtures used Codex CLI 0.172.0, Claude Code 2.1.283, tmux 3.6a and Rex 0.1.0-preview.21. Two real Codex TUIs (standalone tmux and Unix-socket owner server) and one Claude TUI displayed unique annotation markers in their original terminal screens. Model endpoints pointed to an unused loopback port. The checks exercised submission and UI visibility without spending tokens on a model response. A separate temporary Rex server exercised create, rediscover and submit. A fresh Chrome for Testing profile launched the installed host through native messaging, retained its saved draft on reinstall and browser restart, and reached the host again. Installer tests also covered a legacy registration, repeated updates, custom Rex agents and uninstall. GUI focus was not exercised. The direct Terminal.app Apple event timed out, and iTerm2 was unavailable.

```sh
cargo test --locked --manifest-path companion/Cargo.toml
node --test tests/*.test.cjs
node tests/chrome-smoke.cjs "/path/to/Google Chrome for Testing"
```

### Delivery pipelines

Pull requests and pushes to branches build the arm64 companion from source and exercise the installer, update path and toolbar in Chrome for Testing. A version tag runs the checks again, then validates the **signed candidate** (architecture, signature, timestamped build, checksum, extension files and notary payload) and publishes the installer, arm64 archive, Chrome ZIP and checksums to GitHub Releases. Beta tags produce prereleases. By default the maintainer signs on their Mac. Store the signed release inputs in the tag commit so CI can verify and publish those exact bytes.

1. Set the Rust package version and Chrome manifest `version_name` to the intended version, update the release URL in `install.sh`, and increment the numeric Chrome `version` for each Web Store submission. Build with `PANE_PARCEL_SIGN_IDENTITY="Developer ID Application: …" sh scripts/package.sh`, then run `sh scripts/verify-release.sh v<VERSION>`.
2. Configure the GitHub **release** environment for notarization with secret `ASC_KEY_P8` (the multiline App Store Connect API key) and variables `ASC_KEY_ID` and `ASC_ISSUER_ID`. The release workflow waits for Apple to return Accepted. All new tags, including betas, require notarization. Without CI credentials, submit the signed candidate locally with `xcrun notarytool submit dist/paneparcel-notary.zip --keychain-profile PROFILE --wait` and wait for Accepted before tagging. CI checks the Apple ticket for the exact signed executable. A 403 mentioning a missing or expired agreement requires the Apple Developer Account Holder to review the outstanding agreement.
3. Commit the release files, push the commit to main, then push its version tag. To rerun a failed release, rerun the GitHub Actions job for that tag.

### Chrome Web Store

Register a developer account and create the first item in the [developer dashboard](https://chrome.google.com/webstore/devconsole/). Upload the release’s **paneparcel-chrome.zip**. Complete the listing, screenshots, privacy disclosures, distribution and reviewer instructions. Suggested purpose: “Select page elements and send annotated feedback to a local coding agent.” Use the public [privacy policy](PRIVACY.md). Chrome needs `activeTab` and `scripting` for the on-click picker, `storage` for local drafts, `nativeMessaging` for agent delivery, and optional file access for local HTML. For review, install the companion on an Apple Silicon Mac, click the toolbar icon on a sample page, save a note, open a test agent, choose it and send the batch.

Record the **item ID** assigned by Google. If it differs from the unpacked ID `nbodoigokndfjagdocbaobppgepiflpf`, install the companion with `sh install.sh --extension-id STORE_ITEM_ID` before testing that listing. The two IDs have separate Chrome storage. Existing unpacked users can continue to use their original entry.

Enable the Chrome Web Store API and obtain OAuth credentials with the `https://www.googleapis.com/auth/chromewebstore` scope. In the **chrome-web-store** GitHub environment, add variables `CWS_PUBLISHER_ID`, `CWS_ITEM_ID` and secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`. For the initial dashboard upload, submit that version for review in the dashboard. For subsequent versions, run the **Chrome Web Store** workflow with the GitHub Release tag. It verifies the release ZIP checksum, uploads it, waits for processing, and submits it for normal review and publication on approval. Set the repository variable `CWS_AUTO_SUBMIT=true` to trigger this automatically after future GitHub releases. [Google API setup](https://developer.chrome.com/docs/webstore/using-api)

To build and sign on the hosted release runner, configure the release environment secrets `MACOS_SIGN_P12` (base64 PKCS#12) and `MACOS_SIGN_PASSWORD` plus the variable `MACOS_SIGN_IDENTITY`. Without these, the workflow verifies and uses the signed candidate committed for the tag.
