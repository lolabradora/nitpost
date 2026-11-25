# PaneParcel observed beta protocol

Status: **not yet run. Human validation is pending for every item below.** Automated checks cover the mechanics (see `tests/`); they do not show whether a developer finds, understands or trusts them.

Five developers, one session each, about 40 minutes, screen and voice recorded with consent. The facilitator observes and takes notes and does not help unless the participant is stuck for two minutes; any help is recorded as assisted. Source of the tasks and the launch criteria: [prelaunch-feedback.md](prelaunch-feedback.md).

## Participants

| Slot | Agent | Setup | Notes |
| --- | --- | --- | --- |
| P1 | Claude Code | Standalone terminal | |
| P2 | Claude Code | Rex or tmux | |
| P3 | Codex CLI | Standalone terminal, owner server | |
| P4 | Codex CLI | tmux | |
| P5 | Either | Participant's usual setup | Prefer someone who has not seen PaneParcel |

Recruit developers who review browser UI with a coding agent at least weekly. Each brings their own app and a project they can safely let an agent edit on a throwaway branch.

## Before each session

- Apple Silicon Mac, current Chrome, a **clean Chrome profile** with no PaneParcel installed.
- The participant's agent is installed and signed in. Their project is on a throwaway branch.
- The facilitator has the release candidate link, a reference image file (any screenshot of a UI the participant likes), and a test page with a click-opened dropdown and a hover-opened menu.
- Start recording. Note the build: extension `version_name`, companion version, Chrome version, agent version.

## Tasks

Read each task aloud as written. Do not name controls.

| # | Task | What it exercises |
| --- | --- | --- |
| 1 | "Install PaneParcel from this page and send one change request about your own app to the agent conversation you have open." | Install, first note, destination choice, first receipt |
| 2 | "Find a page on a different site that shows something you'd like your app to do. Send a note about it to the same project." | Second origin, remembered destination, per-page drafts |
| 3 | Facilitator asks the participant to write a third note, and closes the agent conversation while they type. "Send it." | Destination gone, error wording, draft survival, recovery |
| 4 | "Get that third note to an agent any way you can." | Check again, choosing another conversation, Copy for agent |
| 5 | "Show the agent what you want this part to look like, using this image." | Reference image paste or file, labelling against the current screenshot |
| 6 | "Open this menu and tell the agent to change one of its items." (click-opened dropdown, then the hover menu) | Keyboard shortcut, picking inside an open menu |
| 7 | "Tell the agent the space between these two sections is too big." | Area selection or grouped elements |
| 8 | On a signed-in page showing an email address: "Send a note about this panel without sending the address." | Screenshot preview and omit |
| 9 | Claude Code participants only. After a send: "Did the agent get it? What would you do now?" | Receipt wording, Send again, Mark as received |

Tasks 1 to 4 are the pilot. Tasks 5 to 9 are probes for the next capture feature: count friction, do not coach.

## Record per participant

| Measure | How |
| --- | --- |
| Time to first note visibly received in the intended session | Stopwatch from opening the install page to the note appearing in the agent's terminal |
| Needed help | Yes or no per task, and what the help was |
| Draft recovered after the failed send (task 3) | Yes or no. Was the note text intact? |
| Sent twice | Count of duplicate deliveries seen in the agent, per task |
| Reached the chosen thread | For every successful send: did it land in the conversation the participant meant? |
| Understood the connection state | Participant's own words for what was wrong in task 3 |
| Used Copy for agent | Found unprompted, found after searching, not found |
| Reference image | Pasted, chose a file, annotated a second site instead, gave up |
| Menu annotation | Shortcut found, used the toolbar, menu closed before the pick, gave up. Record click and hover menus separately |
| Space task | Area, group, single element with a described gap, gave up |
| Screenshot omitted | Noticed the preview, omitted it, sent it anyway without noticing |
| Receipt reading (task 9) | What the participant believed happened, and whether that was true |

Closing questions: What did you expect to happen that did not? Was there a moment you were unsure whether the agent had your note? What would you remove?

## Launch criteria (proposed acceptance targets for the pilot)

| Criterion | Target | Result |
| --- | --- | --- |
| Every draft survives a failed send | 5 of 5 | Pending |
| Every successful send reaches the chosen thread | All sends | Pending |
| Participants finish tasks 1 to 4 unaided | At least 4 of 5 | Pending |
| No unintended duplicate delivery | 0 | Pending |

A miss on the first, second or fourth row blocks launch. A miss on the third prompts a fix to the step that needed help, then a re-test with two new participants.

## What is already checked without people

Filled in from the automated runs recorded in [prelaunch-verification.md](prelaunch-verification.md). Each row there says which of these pilot scenarios it covers and which parts still need an observed session.

## Results

| Participant | Date | Build | T1 time | Unaided 1 to 4 | Draft survived | Duplicates | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Pending | | | | | | |
| P2 | Pending | | | | | | |
| P3 | Pending | | | | | | |
| P4 | Pending | | | | | | |
| P5 | Pending | | | | | | |
