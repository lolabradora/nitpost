---
name: PaneParcel
description: Public website design for the Chrome-to-agent annotation workflow.
colors:
  violet: "#6b40c8"
  field-lilac: "#cdbaff"
  field-iris: "#b9a0f6"
  field-peach: "#f4ab90"
  field-amber: "#f2d083"
  paper: "#f6f5f3"
  card: "#ffffff"
  ink: "#1c1a21"
  body: "#55515c"
  muted: "#6c6773"
  line: "#e3e0e6"
  wash: "#f0ebfb"
  highlight: "#dccdff"
  night: "#1b1920"
  night-line: "#3a3542"
  night-ink: "#ece6f5"
  night-dim: "#a8a0b4"
  night-violet: "#cdb4ff"
typography:
  display:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.85rem, 9.2vw, 6rem)"
    fontWeight: 590
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.2rem, 4.8vw, 3.9rem)"
    fontWeight: 570
    lineHeight: 1.03
    letterSpacing: "-0.038em"
  lede:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.3rem, 2.5vw, 1.85rem)"
    fontWeight: 480
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.2rem, 1.7vw, 1.42rem)"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  action:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 540
  label:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "clamp(12px, 1.12vw, 14.5px)"
    lineHeight: 1.5
rounded:
  pill: "999px"
  field: "clamp(20px, 3vw, 36px)"
  panel: "clamp(18px, 2.4vw, 28px)"
  card: "16px"
  window: "14px"
  control: "9px"
  row: "8px"
spacing:
  gutter: "clamp(18px, 5vw, 72px)"
  field-gutter: "clamp(10px, 2.4vw, 36px)"
  section: "clamp(64px, 8vw, 112px)"
  column-gap: "clamp(32px, 8vw, 110px)"
  action-gap: "24px"
  card-gap: "10px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.card}"
    rounded: "{rounded.pill}"
    typography: "{typography.action}"
    padding: "0 22px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "#3a3346"
  text-link:
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    height: "44px"
  text-link-hover:
    textColor: "{colors.violet}"
  nav-pill:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    typography: "{typography.label}"
    padding: "7px 14px"
  route-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "18px 52px 18px 22px"
  step-number:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    size: "34px"
  command-block:
    backgroundColor: "{colors.night}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.window}"
    typography: "{typography.mono}"
    padding: "10px 10px 10px 18px"
  copy-button:
    backgroundColor: "#ffffff17"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "40px"
  copy-button-done:
    backgroundColor: "{colors.night-violet}"
    textColor: "#241a3d"
  payload-row:
    textColor: "{colors.night-ink}"
    rounded: "{rounded.row}"
    typography: "{typography.mono}"
    padding: "5px 12px"
  payload-row-active:
    backgroundColor: "#7b55d640"
  selector-label:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.card}"
    padding: "2px 6px"
  demo-stage:
    backgroundColor: "{colors.field-iris}"
    rounded: "{rounded.field}"
    padding: "clamp(12px, 3.2vw, 48px) clamp(10px, 3.2vw, 48px) clamp(12px, 2vw, 26px)"
  demo-window:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.window}"
  demo-terminal:
    backgroundColor: "{colors.night}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.window}"
---

# PaneParcel design system

## Overview

**Creative North Star: "The Parcel Handoff"**

The public website is a warm paper page with one working exhibit in the middle of it. A centered headline sits above a wide gradient stage. On that stage a sample browser and a simulated agent terminal play the product's whole sequence on a loop: open the toolbar, pick an element, write a note, choose a conversation, send. The note travels across the stage as a small parcel and lands in the terminal. The visitor can stop the loop and run the same sequence by hand.

Everything outside the stage is quiet. Text is graphite on paper, cards are white with a one-pixel ring, actions are pills, and machine text (JSON, shell commands, terminal output) sits on dark surfaces in monospace. The gradient returns once, as the closing slab. The shop inside the demo keeps its own identity, with a serif title and a lilac sculpture, so the visitor can see where the sample page ends and PaneParcel's controls begin.

**Key Characteristics:**

- Warm paper ground with graphite text and a single violet accent.
- A lilac to peach to amber gradient field, used for the demo stage and the closing slab.
- Centered hero and section headings in tightly tracked Geist.
- Pill actions, white cards with hairline rings, dark monospace surfaces.
- A self-running demo that the visitor can take over, with reduced motion respected throughout.

## Colors

A warm off-white page, cool graphite neutrals with a slight violet cast, one violet accent, and one multi-stop gradient.

### Primary

- **Selection Violet** (`violet`): the second line of the hero headline, the rotating word in the lede, the global focus ring, the selector label, the selected-element outline, the active toolbar button, and the native accent and caret colors. Inside the demo the same value is declared again as a local property.

### Secondary

- **The Field** (`field-lilac`, `field-iris`, `field-peach`, `field-amber`): four stops of one gradient, `linear-gradient(158deg, lilac 0%, iris 30%, peach 68%, amber 100%)`, stored as the `--field` property. It fills the demo stage and the closing slab. The stage paints a flat lilac (`#c7b2fb`) underneath in case the gradient layer is missing.

### Neutral

- **Warm Paper** (`paper`): the page ground and, at 78% opacity with a backdrop blur, the sticky masthead.
- **Card White** (`card`): cards, the navigation pill, step numbers, keycaps, the sample browser, and the note dock.
- **Graphite Ink** (`ink`): headings, links, and the fill of the primary button.
- **Body Graphite** (`body`): paragraphs and resting navigation links.
- **Muted Graphite** (`muted`): footnotes, sample-page metadata, and the accordion chevron.
- **Hairline** (`line`): one-pixel rings and dividers.
- **Lilac Wash** (`wash`): the ground behind the payload specimen and the selector chip in the note dock.
- **Highlight Lilac** (`highlight`): text selection and the marker behind the specimen title when the `text` field is active.
- **Night** (`night`) and **Night Line** (`night-line`): the code pane, the command block, the terminal, and the divider inside the code pane.
- **Night Ink** (`night-ink`), **Night Dim** (`night-dim`), **Night Violet** (`night-violet`): primary text, punctuation and secondary text, and string values and focus rings on dark surfaces.

The terminal also uses two status greens that appear nowhere else: a session dot (`#8fe0a8`) and the completion line (`#a9e9bd`).

### Named Rules

**The One Violet Rule.** Violet is the only accent on paper. It marks what is selected, focused, or currently active, plus one line of the hero. It is never a button fill on the page itself.

**The Two Fields Rule.** The gradient appears as a large rounded slab, twice per page: the demo stage and the closing block. It is not applied to text, buttons, cards, or borders.

**The Night Is For Machines Rule.** Night surfaces hold monospace content a machine reads or prints: the JSON payload, the install command, the terminal. Prose and navigation stay on paper or white.

## Typography

**Display Font:** Geist (with -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif)
**Body Font:** Geist (same stack)
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo, Consolas, monospace

**Character:** Geist is self-hosted as one variable file covering weights 100 to 900, which lets headings sit at in-between weights. Large type is tight and close-tracked; body text is open, with a 1.55 to 1.6 line height.

### Hierarchy

- **Display** (590, `clamp(2.85rem, 9.2vw, 6rem)`, 0.98, -0.04em): the two-line hero headline. Each line is a block; the second is violet.
- **Headline** (570, `clamp(2.2rem, 4.8vw, 3.9rem)`, 1.03, -0.038em): every section heading and the closing heading.
- **Lede** (480, `clamp(1.3rem, 2.5vw, 1.85rem)`, 1.3, -0.025em): the single line under the hero headline that contains the word reel.
- **Title** (600, `clamp(1.2rem, 1.7vw, 1.42rem)`, 1.25, -0.025em): install step headings. Accordion summaries use a close variant (560, 1.12rem, -0.015em).
- **Body** (400, 1rem, 1.6): section paragraphs, capped between 40ch and 62ch. Hero and section introductions run slightly larger (up to 1.12rem, 1.55).
- **Action** (540, 15px): the primary button and text links.
- **Label** (400, 14px): navigation. The brand wordmark is 19px at 620 with -0.035em tracking.
- **Mono** (`clamp(12px, 1.12vw, 14.5px)`, 1.5): the payload. Inline code and keycaps in the install steps are 0.88em; the terminal is 12px with a 1.65 line height.

Headings use `text-wrap: balance` and paragraphs use `text-wrap: pretty`.

### Named Rules

**The In-Between Weight Rule.** Weights fall between the usual steps: 480, 540, 560, 570, 590, 600, 620. Nothing on the page is set bolder than 650, and strong text in prose is 600 in ink.

**The Mono Means Literal Rule.** Monospace is reserved for text the visitor could copy or that a machine produced: selectors, URLs, paths, commands, JSON, terminal lines, and the viewport readout.

## Layout

Text sections share a centered column that tops out at 1120px with a `gutter` of `clamp(18px, 5vw, 72px)`. The two gradient slabs break out of that column: they run to 1320px with a narrower `field-gutter`, so the stage reads wider than the text above and below it.

The hero and the payload section are centered. The routes and install sections are two columns (0.85fr and 1.15fr) with a `column-gap` of `clamp(32px, 8vw, 110px)`, heading on the left and detail on the right; the install heading column is sticky at 96px from the top. The payload explorer is a two-column panel, specimen on the left and code on the right.

Vertical rhythm is fluid. Sections use `clamp(64px, 8vw, 112px)` of block padding, and the payload section opens with `clamp(88px, 12vw, 168px)` after the stage. The sticky masthead is 64px tall (56px on small screens).

At 860px the explorer, routes, and install sections collapse to one column and the install heading stops sticking. At 560px the optional navigation link is hidden, step numbers shrink from 34px to 30px, and the command block stacks its copy button below the command.

The demo responds to its own width through container queries, not the viewport. Below 780px the terminal moves under the browser at a fixed 232px height. Inside the browser, the review row places fields beside actions at 600px and wider, and below 470px the product spread stacks, the chrome compacts, and dock actions share the row equally.

## Elevation & Depth

Depth is a hybrid. Most surfaces are flat white on paper and separated by a one-pixel ring. Shadows are reserved for objects that sit on top of something else: windows on the gradient stage, the dock over the sample page, the open accordion card, and the payload panel. Every shadow is tinted violet-plum, soft, and pulled inward with a negative spread so it reads as contact, not glow.

### Shadow Vocabulary

- **Hairline ring** (`box-shadow: 0 0 0 1px var(--line)`): resting cards, step numbers, the path chip. The navigation pill uses the inset form.
- **Window** (`box-shadow: 0 30px 60px -28px #2d1a5080, 0 4px 12px #2d1a5022`): the sample browser and terminal on the stage.
- **Dock** (`box-shadow: 0 0 0 1px #1c1a211a, 0 22px 40px -18px #2d1a5066, 0 3px 8px #2d1a5018`): the picker bar and note panel floating over the sample page.
- **Panel** (`box-shadow: 0 0 0 1px var(--line), 0 30px 60px -40px #3a285e55`): the payload explorer.
- **Open card** (`box-shadow: 0 0 0 1px #cfc8d8, 0 18px 30px -26px #3a285e66`): the expanded accordion item.
- **Specimen frame** (`box-shadow: 0 0 0 1px #1c1a2114, 0 18px 34px -22px #3a285e66`): the miniature browser in the explorer. Its ring becomes 2px violet when the viewport field is active.
- **Mark** (`filter: drop-shadow(0 14px 16px #4a2c8e55)`): the app icon on the closing slab.

The masthead has no shadow or border. It separates from the page through translucency (`backdrop-filter: saturate(1.6) blur(18px)`).

### Named Rules

**The Ring-Not-Border Rule.** Outlines on cards and controls are drawn as a one-pixel `box-shadow` ring, so state changes can restyle the ring and add lift in one transition. Real borders are used only as dividers inside a surface.

## Shapes

The form language is round. Actions, the navigation pill, the "Optional" tag, the picker bar, and demo buttons are full pills (999px). The two gradient slabs use the largest radius (`clamp(20px, 3vw, 36px)`), the payload panel the next (`clamp(18px, 2.4vw, 28px)`), accordion cards 16px, windows and the command block 14px, and small controls 8px to 9px. Step numbers are circles.

Selection is the exception. The selected element keeps square corners: a 2px violet outline offset by 4px to 5px, with a square-cornered selector label attached above its top-left corner. This keeps the selection reading as a measurement of the target, not as another card.

Icons are inline SVG line drawings with a 1.65 stroke and round caps and joins. The only recurring icon is the outbound arrow.

## Components

### Buttons

- **Shape:** full pill (999px), 48px tall.
- **Primary:** ink fill, white text, 22px horizontal padding, 15px at weight 540, with a trailing outbound arrow.
- **Hover / Focus:** hover lightens the fill to `#3a3346` over 0.2s and nudges the arrow 2px up and right. Press scales to 0.97. Focus draws the global 2px violet outline at 3px offset.
- **Text link:** the secondary action. Ink text, 44px minimum height, underlined in a pale graphite (`#b9b3c2`). Hover turns the text and underline violet. On the closing slab the underline is darker and hover stays ink.

### Navigation

A sticky translucent masthead holds the brand (icon plus wordmark) and three links in body graphite that darken to ink on hover. The GitHub link is a white pill with an inset hairline ring that darkens on hover. Below 560px the Payload link is hidden.

### Cards / Containers

- **Corner Style:** 16px for accordion cards, up to 28px for the payload panel.
- **Background:** white on paper.
- **Shadow Strategy:** hairline ring at rest; ring plus a soft lift when open or featured.
- **Border:** none. See the Ring-Not-Border Rule.
- **Internal Padding:** 18px to 22px.

### Route accordion

Three native `details` elements sharing one `name`, so opening one closes the others. The summary is a full-width row with a chevron drawn from two borders that rotates when open. A small gray pill inside a summary tags an optional route. The body height animates open and closed.

### Install steps

An ordered list with CSS counters. Each number sits in a 34px white circle with a hairline ring, and a one-pixel line connects consecutive steps. Keyboard keys are small white keycaps with a ring and a one-pixel lower edge.

### Command block

A night surface (14px radius) with the command in monospace, a non-selectable `$` prompt in pale violet, and a translucent white copy button. The command is selectable in one click. On copy the button turns night violet and reads "Copied" for 1.8 seconds, and a status line confirms. If the clipboard is unavailable the command is selected instead and the status says so. The button only appears when scripting is available.

### Payload explorer

A two-pane panel. The left pane is a miniature of the sample page on a lilac wash: URL bar, selected title with its selector label, the note, and a viewport ruler. The right pane is the JSON payload on night, where each field is a button, with a caption below explaining the active field. Activating a field lights the matching part of the specimen: the URL turns violet, the title gains its outline or its highlight marker, the note lifts with a violet ring, or the ruler extends to full width. Hovering a part of the specimen activates its field in return.

### Inputs / Fields

Inputs exist only inside the demo's note dock. Textarea and selects are white with an 8px radius and an inset one-pixel ring (`#c4bdcb`) that darkens on hover. Focus draws a 2px violet outline at 3px offset. Disabled selects turn pale gray. Dock buttons are 36px pills: a dark primary and a white ringed secondary.

### Demo stage (signature)

A gradient slab holding two windows side by side: a sample browser showing the Forma shop page, and a dark terminal labeled "Simulated".

- **Autoplay.** While at least 30% of the scene is on screen, a ghost cursor runs the full sequence: it clicks the toolbar button, hovers the image, picks the title, types "Make this title larger." one character at a time, saves, chooses a project and conversation, and sends in the background.
- **Parcel.** On send, the app icon lifts from the send button, arcs across the stage in 950ms, and fades into the terminal, which answers with a white ring pulse. The terminal prints the payload, then two agent steps and a completion line, and the sample title scales up 24% in the browser. After a 4.2 second hold the loop restarts.
- **Hand-over.** During autoplay both windows are inert and the whole scene is one button; its visible label is a dark "Try it yourself" pill at the lower right. Activating it stops the loop, resets the scene, and moves focus to the toolbar button, which shows a pulsing violet beacon while idle. A guide line below the stage then gives the next instruction as a status message, with Restart and "Watch the demo" controls beside it.
- **Manual sequence.** Idle, pick, edit, review, sent. Pickable elements show the violet outline and selector label on hover or focus. The dock floats over the sample page, and the page shifts up when the dock would cover the selection. Escape resets. The manual run ends in the terminal with a receipt line and does not simulate an agent edit.

## Motion

Motion is a feature of this page, concentrated in the demo. Arrivals and state changes use one easing, `--ease-out` (`cubic-bezier(.16, 1, .3, 1)`), over 0.2s to 0.9s. Travel between two points (the ghost cursor, the parcel, the word reel) uses in-out curves.

- **Hero arrival.** Headline lines, lede, copy, actions, and the stage rise 22px from a 10px blur over 0.9s, staggered from 0 to 0.42s. The stage takes 1.1s.
- **Word reel.** The last words of the lede roll once through four destinations over 4.6s and stop on "your coding agent." The reel is hidden from assistive technology, which reads the final phrase.
- **Stage settle.** Where scroll-driven animation is supported, the stage and the closing slab scale from 0.93 and tighten from a 56px radius as they enter the viewport.
- **Drifting field.** The stage gradient drifts, rotates 8 degrees, and scales to 1.08 over 16s, alternating, only while the stage is on screen.
- **Payload tour.** The explorer steps to the next field every 2.4s while at least 40% visible.
- **Accordion.** Body height animates over 0.45s and the chevron rotates over 0.35s.
- **Small responses.** Outbound arrows shift 2px on hover, pills compress to 0.94 to 0.97 on press, the dock rises 18px on entry, terminal lines rise 6px, and the terminal caret blinks.

### Named Rules

**The Hand-Over Rule.** Anything that runs by itself stops when the visitor acts on it and stops when it leaves the screen. The demo yields to "Try it yourself"; the payload tour ends permanently on the first hover, focus, or click.

**The Reduced Motion Rule.** With reduced motion requested, the demo starts in manual mode with no autoplay and no replay control, the parcel flight is skipped, the payload tour does not start, smooth scrolling is off, and all animation and transition durations are zero. The reel rests on its final phrase.

## Do's and Don'ts

### Do:

- **Do** keep commands, selectors and paths visually distinct from prose by setting them in monospace.
- **Do** keep the browser example usable when its layout stacks; size it with container queries, not viewport queries.
- **Do** draw card and control outlines as a one-pixel ring in the hairline color, and add lift only when a surface is open or floating.
- **Do** use the pill (999px) for every action and keep the primary button ink on paper.
- **Do** give every self-running sequence a visible way to take over, and stop it when it is off screen.
- **Do** label simulated output as simulated, as the terminal header and the delivery panel do.

### Don't:

- **Don't** carry the example shop’s serif face into PaneParcel navigation, headings, or body text.
- **Don't** use the gradient field on text, buttons, or cards, or add a third field to the page.
- **Don't** use violet as a page button fill or as decoration; it marks selection, focus, and active state.
- **Don't** put prose on night surfaces.
- **Don't** round the corners of the selection outline or its label.
- **Don't** start autoplay, the payload tour, or the parcel flight when reduced motion is requested.
