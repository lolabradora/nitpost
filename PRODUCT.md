# PaneParcel

PaneParcel lets someone reviewing a web page select an element, annotate it, and send the note to a coding agent. Each note includes the URL, CSS selector, a text excerpt, viewport dimensions, its kind (change request or question) and a cropped screenshot of the selection, which the user previews and can leave out. A note can instead mark an area of the page, which has coordinates and no selector, or several elements under one comment, and can carry one reference image of the wanted result. Notes can be batched. Users choose the project and named conversation after saving their notes. Eligible standalone Codex CLI and Claude Code sessions can receive notes directly. Optional Rex integration can target a pane or start a new session. Copy for agent puts the notes on the clipboard as text with no companion or destination. Each page keeps a record of its last send: destination, time and what was confirmed. A send without a receipt is resent only when the user chooses to.

## Platform

web

The Chrome extension starts from its toolbar icon or its Chrome keyboard shortcut. Its signed, Apple-notarized Rust companion runs on Apple Silicon macOS. The GitHub beta installer registers the companion and installs the extension for unpacked setup. Sending keeps the user in Chrome. PaneParcel delivers to the selected live conversation. An eligible destination needs a Claude peer inbox, an idle Codex thread on its local owner server, or a supported ready pane in Rex or tmux. Terminal window automation and deferred queues are outside the product scope.

## Public website

The English landing page demonstrates the toolbar, element selection, note and conversation workflow and explains installation. The inferred primary audience is developers reviewing browser UI with Claude Code or Codex. The web implementation uses static HTML, CSS and JavaScript so the demonstration can run locally from the repository.
