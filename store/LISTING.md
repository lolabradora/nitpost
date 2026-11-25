# Chrome Web Store submission

**Name:** PaneParcel
**Category:** Developer Tools
**Summary:** Select a page element, write a note, and send the page context to your local Claude Code or Codex conversation.

**Description:** Click PaneParcel in the Chrome toolbar, choose an element and write a note. Review the batch, choose your project and conversation, and send it. Each note contains the page URL, CSS selector, a text excerpt and the viewport size. Drafts stay in Chrome until you send or remove them. Sending to coding agents requires the free companion for Apple Silicon Macs. Install it from GitHub Releases. Rex is optional. Some destinations support focusing the original conversation after delivery.

**Website and support:** https://github.com/lolabradora/paneparcel
**Privacy policy:** https://github.com/lolabradora/paneparcel/blob/main/PRIVACY.md
**Screenshot:** `toolbar-1280x800.png` shows the real annotation editor.

## Privacy and permissions

The single purpose is to send user-selected page annotations to the user's coding agent. Declare the handling of website content, web addresses and user-entered notes. The extension has no analytics or developer-operated backend. Sending data to the selected agent is initiated by the user. Explain the agent's model-provider boundary using the linked policy.

- `activeTab` and `scripting`: run the packaged picker when the user clicks the toolbar icon.
- `storage`: keep notes, recent projects and destination preferences in the current Chrome profile.
- `nativeMessaging`: communicate with the locally installed PaneParcel companion.
- Optional file access: let users annotate local HTML after enabling Chrome’s file-URL permission.

## Reviewer steps

1. Open an ordinary web page, click the toolbar icon, select a heading, enter a note and save it. Close and reopen the picker to see the saved note.
2. On an Apple Silicon Mac, install the companion from GitHub Releases. When testing the store item, run the release installer with `--extension-id <dashboard item ID>`.
3. Open a supported local agent destination. Choose its project and conversation, send a disposable note, and check receipt. No PaneParcel account or login is required.
