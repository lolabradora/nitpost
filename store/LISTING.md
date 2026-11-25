# Chrome Web Store submission

**Name:** Nitpost
**Category:** Developer Tools
**Summary:** Select a page element, write a note, and send the page context to your local Claude Code or Codex conversation.

**Description:** Click Nitpost in the Chrome toolbar, choose an element and write a note. Review the batch, choose your project and conversation, and send it. Each note includes the page URL, viewport size, and the selected element, group or area. You can review the text excerpt and cropped screenshot and leave either out. A note can also mark an area of the page or several elements, and can include one reference image of the result you want. Drafts stay in Chrome until a send removes them or you do. Copy for agent copies your notes as text for any agent with nothing else installed. Sending directly to a coding agent requires the free companion for Apple Silicon Macs. Install it from GitHub Releases. Rex is optional. Sending keeps you in Chrome.

**Website and support:** https://github.com/lolabradora/nitpost
**Privacy policy:** https://github.com/lolabradora/nitpost/blob/main/PRIVACY.md
**Screenshot:** `toolbar-1280x800.png` shows the real annotation editor.

## Privacy and permissions

The single purpose is to send user-selected page annotations to the user's coding agent. Declare the handling of website content, web addresses and user-entered notes. The extension has no analytics or developer-operated backend. Sending data to the selected agent is initiated by the user. Explain the agent's model-provider boundary using the linked policy.

- `activeTab` and `scripting`: run the packaged picker when the user clicks the toolbar icon or presses the extension shortcut, and capture the visible tab once per selection to crop a screenshot the user can preview and leave out.
- `storage`: keep notes, recent projects and destination preferences in the current Chrome profile.
- `nativeMessaging`: communicate with the locally installed Nitpost companion.
- Optional file access: let users annotate local HTML after enabling Chrome’s file-URL permission.

## Reviewer steps

1. Open an ordinary web page, click the toolbar icon, select a heading, enter a note and save it. Close and reopen the picker to see the saved note. Press Copy for agent and paste the text anywhere to see the note without the companion.
2. On an Apple Silicon Mac, install the companion from GitHub Releases. Use the installer for this version. It registers the official Web Store item ID `hjaimaioehmmfbfclcmmphhenealomfp` automatically.
3. Open a supported local agent destination. Choose its project and conversation, send a disposable note, and check receipt. No Nitpost account or login is required.
