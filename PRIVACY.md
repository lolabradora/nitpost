# Nitpost privacy

Nitpost is a local annotation tool for developers. It activates when you click its toolbar icon or press its keyboard shortcut. Selecting a page element records its CSS selector, a short text excerpt, the page URL and viewport dimensions alongside your comment and whether it is a change request or a question. A note on several elements records the selector and excerpt of each. A note on an area records the area's position and size on the page and has no selector. File URLs can include your local folder and file names.

Making a selection captures the visible tab once and crops it to the selection. The crop can show whatever is displayed there, including text you did not mean to share. Nitpost shows you the crop before you save the note, and you can leave it out. A screenshot you leave out is discarded and is never stored or sent. The editor also shows the text excerpt it recorded, and you can leave that out or remove it from a saved note. You can also attach one reference image to a note by pasting it or choosing a file. Nitpost keeps a reduced JPEG copy of it with the note.

Drafts, their screenshots and reference images, recent folders, destination preferences and a record of the last send from each page (time, destination and what was confirmed) are stored in Chrome’s local extension storage. A draft and its images stay there until you remove the note or a send removes it. Sends that the destination confirms, or that are typed into a terminal pane, remove their notes. A send with no receipt, such as a Claude Code peer inbox, keeps the notes until you mark them as received or remove them. The record of a delivered send, which includes the page URL, is deleted after seven days. The record of a send that was not confirmed stays until you settle it or remove its notes.

**Copy for agent** places the text of your notes on the system clipboard: the page URL, your comments, selectors, excerpts and area positions. Images are not copied. Anything that reads your clipboard can read that text.

When you send, the companion writes each screenshot and reference image to a private file in `~/Library/Caches/com.micovi.nitpost/shots` on your Mac and gives the agent its path. Each time Chrome contacts the companion, which happens when you open the review bar, check for conversations or send, the companion deletes files in that folder that are more than seven days old. No background process runs between those moments, so if you stop using Nitpost the remaining files stay until you delete the folder or uninstall the companion, which removes it.

The native companion discovers supported local coding-agent sessions on your Mac and returns destination information to the extension. The extension and the companion operate without a developer-operated account, analytics service or cloud backend. The Nitpost website is separate and counts visits, as described below.

When you send a batch, the selected agent receives the annotations, including the full URL, any query string and the paths of the image files. That agent may send the content, and the images if it opens them, to its configured model provider under its own settings. Some local delivery routes use process arguments. Choose pages and destinations accordingly.

**Report a problem** in the review panel opens GitHub's new-issue page in a new tab with a draft that Nitpost fills in: the Nitpost version, Chrome's major version and your operating system, the state of the companion connection (the helper in the interface) and, if the page has a send record, the last send's status and the kind of destination. The send's message is added only when it is one of four fixed sentences written by Nitpost. The draft never includes the page URL, your notes, selectors, excerpts, paths, conversation names or images. The draft travels to GitHub in the address of that tab, and nothing is posted unless you submit the issue there.

Remove individual notes, screenshots and reference images in the review panel. Remove the extension to clear its local storage. The companion can be uninstalled separately using the command in the README. For privacy questions, open an issue at https://github.com/lolabradora/nitpost/issues without posting private annotations.

## Website

The Nitpost website at https://lolabradora.github.io/nitpost/ is hosted by GitHub Pages. It counts page views and five kinds of click with [GoatCounter](https://www.goatcounter.com): copying the install command, copying the skill command, and opening the releases, GitHub or privacy links. The site sets no cookies and stores no identifier in your browser.

On each page your browser loads GoatCounter's script from `gc.zgo.at`. For a page view or one of those clicks it sends one request to `nitpost.goatcounter.com` with the page path or the name of the click, the page title, the query string of the address if there is one, the referring address for a page view, and your screen size and pixel ratio. Like any web request it also carries your IP address and your browser's User-Agent and language headers. Nothing you type on the site is sent.

GoatCounter keeps hourly and daily totals per path, referrer, browser and version, operating system, screen width, language and country. It works out the country from the IP address and stores neither the IP address nor the full User-Agent. To count a repeat visit once, it keeps a value made from the site, the IP address and the User-Agent in memory for up to eight hours and does not write it to its database. See [GoatCounter's privacy policy](https://www.goatcounter.com/help/privacy).

A content blocker that blocks GoatCounter leaves the site working. To stop your browser being counted without one, open any page of the site with `#toggle-goatcounter` at the end of its address. GoatCounter's script then saves that choice in the site's local storage, which is the only thing the site stores in your browser.

## Removing the extension

When you remove the extension, Chrome opens https://lolabradora.github.io/nitpost/uninstalled.html in a new tab. The address carries only the version that was installed, for example `?v=0.3.0-beta.2`, and no identifier. That visit is counted like any other page view on the website, under a path that includes the version. The page asks why you removed Nitpost. Answering is optional, and a reason is recorded only if you click one: the click is counted under a name such as `uninstall-reason-send-failed` together with the version.
