# PaneParcel

Annotate elements on a web page and send the notes to Claude Code or Codex in Rex. Each note includes your comment, the element’s CSS selector, a text excerpt, and the viewport size. You can send a batch to an existing conversation or start one in a local project folder.

The current integration uses Rex to find and open terminal panes. Sessions started directly in Terminal.app, iTerm2, or another terminal are outside its reach.

## Install on macOS

You’ll need Google Chrome, Python 3.8 or later, and Rex installed on your Mac. Run the installer from a terminal where `rex` is on your PATH. To start new conversations from Chrome, make sure you can also run `codex` or `claude` in that terminal. This version was tested with Rex 0.1.0-preview.21.

1. From the repository root, run `python3 host/install.py`. This registers the local helper with Chrome for your user account.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the **extension** folder in this repository.
3. Reload an HTTP or HTTPS page and click **Annotate** in the lower-right corner.

## Annotate a page

Click an element, write your comment, and choose **Save note**. Use **Pick another element** to keep going. In the review panel you can edit or remove individual notes. Then choose where to send your notes.

1. **Project** lists folders with active agents in Rex and your recently used folders. Select **Choose folder…** to open the macOS folder picker. The selected path appears below the field.
2. **Conversation** lists agents running in that folder. Pick a conversation whose prompt is ready for input, or choose **New Codex session** or **New Claude Code session**.
3. Click **Send in background** to stay in Chrome, or **Send + focus Rex** to bring the destination session, tab, and pane to the front after delivery. For a new conversation, either action starts a Rex session in the chosen folder with the batch as the agent’s initial prompt. Its name in the Rex switcher includes the project and agent, for example `starter · Codex`. Later batches use that same conversation. Complete any first-run sign-in or project trust prompt in Rex.

Saved notes belong to the exact page URL. PaneParcel remembers your project and conversation for each site, and separately for each `github.com/owner/repository`. Your last 12 project folders are available across sites. If delivery is uncertain, check the conversation before retrying.

- **Keyboard** — Tab to the launcher and press Enter. In picking mode, Tab to a focusable page element and press Enter to annotate it. Save with ⌘/Ctrl + Enter or cancel with Escape.
- **Page access** — The launcher appears on ordinary HTTP and HTTPS pages where you grant the extension site access. The picker works in the top-level document. An embedded frame or shadow component can be selected as a whole.
- **Local storage** — Saved notes stay in Chrome's local extension storage until you send or remove them. Sending shares the full URL (including query and fragment), selected element context, and comments with your chosen agent. For a new session the initial prompt is a CLI argument, visible to local process inspection tools. The agent uses its own configured model provider.

## Rex setup

Use the refresh button beside **Project** to discover panes you opened or renamed in Rex. For another interactive CLI that accepts pasted prompts and Enter, register its foreground executable name, for example `python3 host/install.py --agent opencode`. Repeat the flag for additional names. Each installation replaces the previous custom list.

After updating the source, rerun the installer, reload the extension in Chrome, and refresh open web pages. To uninstall, remove the extension in Chrome and run `python3 host/install.py --uninstall`.

## Development

`extension/content.js` owns the picker and review panel. `extension/background.js` saves drafts and calls the local helper through Chrome Native Messaging. `host/bridge.py` discovers foreground agents and delivers messages through the Rex CLI.

Run the tests with Node.js 18+ and Python 3.8+:

```sh
node --test tests/background.test.cjs
python3 -m unittest discover -s host -v
```
