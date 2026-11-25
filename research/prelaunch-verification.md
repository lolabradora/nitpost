# PaneParcel prelaunch verification record

November 25, 2026 · working tree on `main`, version 0.3.0-beta.2, nothing committed or published. Backlog: [prelaunch-feedback.md](prelaunch-feedback.md). Human sessions: [beta-protocol.md](beta-protocol.md), all pending.

Every destination in these runs was a disposable fake in a temporary HOME. No real Claude Code, Codex, tmux or Rex session was contacted.

## Pre-packaging run

| Command | Result |
| --- | --- |
| `cargo fmt --manifest-path companion/Cargo.toml -- --check` | Clean |
| `cargo clippy --manifest-path companion/Cargo.toml --all-targets -- -D warnings` | Clean |
| `cargo test --locked --manifest-path companion/Cargo.toml` | 30 unit and 13 end-to-end passed |
| `python3 -m unittest discover -s host` | 16 passed |
| `node --test tests/background.test.cjs` | 71 passed |
| `node tests/chrome-ui.cjs "<Chrome for Testing 159.0.8154.6>"` with `PANEPARCEL_COMPANION` set to the debug companion | 28 scenarios, 438 checks passed, 0 failed, about 6 minutes |
| `node --test tests/install.test.cjs` in the checkout | **Fails**: `dist/` predates the current `extension/` |
| `node tests/chrome-smoke.cjs` in the checkout, both modes | **Fails**: the packaged helper predates connection checks |
| The same installer and smoke tests from a scratch copy packaged with `scripts/package.sh` (ad-hoc signature) | Installer passes with and without `CI=1`; smoke passes in both modes |
| `actionlint .github/workflows/ci.yml` | Clean |

## What each backlog item rests on

| Item | Automated evidence | Still needs a person |
| --- | --- | --- |
| Copy for agent with no companion or destination, drafts kept | Chrome: helper missing, insecure http page, invalidated extension context. Text checked field by field; drafts and storage unchanged; no helper request | Whether people find it unprompted (tasks 3, 4) |
| Connection, eligibility and retry states | Chrome: missing, unreachable, discovery error, none eligible with per-route reasons, saved conversation gone, Check again sends nothing. Rust end to end: `checks` from the real companion | Whether the wording is understood (task 3) |
| Last attempt: time, target, receipt; resend under user control | Service worker: every status, pending record across a worker restart, resend guard, stale-tab refusal. Chrome: all five statuses after reload, Send again exactly once more, Mark as received, Keep as drafts, worker stopped mid-send, hung helper released after 120 s. Rust: classification per route and failure point | Reading of the wording against a real Claude inbox (task 9). Real tmux, Rex and Claude routes |
| Screenshot preview and omit | Chrome: preview before save, omitted crop never stored or sent, removal in review. Service worker: `state` never returns image bytes | Whether people notice the preview (task 8) |
| Reference image, distinct from the current screenshot | Chrome: file chooser and paste, labels in editor and review, separate fields in the helper request. Rust: separate file and guide line in the agent message | Whether the two names are understood (task 5) |
| Area selection without a selector | Chrome: drag over empty space, two clicks, scroll, RTL negative offsets. Service worker and Rust reject an area that carries a selector | Whether people reach for it (task 7) |
| One comment on several elements | Chrome: toggle and Shift+click; stored note and helper request | Task 7 |
| Keyboard activation for transient menus | Chrome: manifest command present, Chrome reports ⌥⇧P, shown in the picker; click dropdown, `popover`, `<details>` stay open and are picked by pointer and by Tab then Enter, crop taken while open | A physical key press, hover menus with a real pointer, native `<select>` lists, menus that close on window blur (task 6) |
| Chrome summary about Rex | Manifest description no longer mentions Rex | |
| Screenshot retention matches the policy | Rust: pruning on every invocation, uninstall removes the folder, no file written for a closed destination. PRIVACY.md rewritten to the same behaviour | |
| Data migration | Service worker and Chrome: beta.1 and beta.2 notes with `destination:` and `target:` keys render, edit, copy and send. Smoke: upgrade keeps notes and extension ID (scratch copy) | |
| Source-URL isolation, navigation, offline, reconnect | Chrome: full navigation, `pushState`, hash, late reply after a route change, offline capture and copy, recovery with Check again | Two SPA routes in a participant's own app |
| Duplicate sends | Chrome: double click, two tabs, stale Send again. Service worker: three concurrent sends | Count of duplicates seen in real agents |
| Privacy | Chrome: with screenshot and excerpt left out, the address on the signed-in fixture is absent from storage, the copied text and the helper request | Task 8 |
| Keyboard | Chrome: a whole note without the pointer, focus visible on named controls, mode key, hostile form names, page removing the overlay | Screen reader output |
| Desktop and narrow layout | Chrome: six states at 1280, 860, 480 and 360 px, nothing outside the viewport | Visual judgement; animations without reduced motion |
| Pilot tasks 1 to 4 | Chrome against the fake helper: first note, second origin with remembered destination, destination closed, recovery; each note delivered once | The pilot itself |

## Review

An independent read of the working tree found one defect that could deliver a batch twice with an older installed helper, and eight lesser ones. All nine were fixed and are covered by tests named in the table above. The Chrome suite then found three more (keyboard activation of pick-bar buttons, a hung helper blocking every tab, the excerpt carrying text the user had tried to keep back). Those are fixed and covered too.

## Known limits

- While a send is waiting on a helper that has hung, the toolbar click shows no controls in any tab for up to two minutes. After that the send is recorded as having no result and everything is released.
- With a helper older than this build, any refused send reads as "No result recorded", because that helper does not say whether delivery had started.
- A modal `<dialog>` makes the overlay inert. Picking inside it works; the note can be typed after the dialog closes.
- Area positions are relative to the document. In an app that scrolls an inner container, the pin does not follow the content.
- Area by keyboard uses the focused element's box. Empty space needs a pointer (drag, or two clicks).
- Escape in the editor discards a typed comment without asking.
- At 360 px wide the review panel can cover note cards.
- Keyboard focus occasionally leaves the bar after choosing a project or conversation (about one run in four). Tab reaches Send again.
- While picking, the M key is taken from the page unless focus is in a text field.
- The sweep of old send records needs Chrome 130 or later. Older versions clean a record only when its page is reopened.
- The tmux route is covered by unit tests with a scripted tmux, not end to end.
- Whether `rex new` brings Rex to the front is Rex's behaviour and was not observed.
- The landing page demo in `docs/` does not show the new capture modes.

## Signed release candidate

The local candidate is **v0.3.0-beta.2** (Web Store version **0.3.0.2**). The store ZIP, standalone arm64 archive and installer are described by [SHA256SUMS](../dist/SHA256SUMS). These replace the stale artifacts described in the pre-packaging run above.

- Apple accepted submission `2c0584ad-40a0-46c7-b4cf-b63c59f402e8`. Its arm64 ticket CDHash matched the executable extracted from the final archive. The executable passed the explicit notarization requirement.
- All 72 Node tests, 30 Rust unit tests, 13 Rust integration tests and 16 Python tests passed. Chrome for Testing exercised both fresh installation and legacy migration with the final package. A separate upgrade from the downloaded public beta.1 kept the native registration intact and installed the optional Codex skill.
- The final Chrome UI run used the signed companion extracted directly from the release archive. All 438 checks across 28 scenarios passed. The staged Git tree also passed the release verifier and installer test after export into an empty directory.
- Public and local-preview install commands were checked in Chrome. The [release notes](../releases/v0.3.0-beta.2.md), [reviewer instructions](../store/LISTING.md), and [1280 × 800 editor screenshot](../store/toolbar-1280x800.png) are ready. Both release and CI workflows pass actionlint.
- Publishing requires pushing the candidate commit and version tag. Update the existing Chrome Web Store item with the verified ZIP, new screenshot and privacy disclosures after GitHub publication. For automated submission, provision the Chrome workflow's OAuth credentials; the publisher and item IDs are already configured.
- Human validation is pending. Record the five observed sessions in the [pilot protocol](beta-protocol.md). Known limits above still apply.
