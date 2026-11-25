// The page owns the document. Keep controls, note text and their event handlers in a closed shadow tree.
(async () => {
  if (globalThis.toggleNitpost) {
    await globalThis.toggleNitpost();
    return;
  }
  // A form control named like a DOM property replaces that property on its form, and a named element
  // does the same on the document: <input name="parentElement"> makes form.parentElement the input.
  // Everything read from a page node therefore goes through the prototype, never through the node.
  const reader = (proto, name) => {
    const read = Object.getOwnPropertyDescriptor(proto, name).get;
    return node => read.call(node);
  };
  const method = (proto, name) => {
    const run = proto[name];
    return (node, ...args) => run.apply(node, args);
  };
  const parentOf = reader(Node.prototype, 'parentElement');
  const connected = reader(Node.prototype, 'isConnected');
  const kindOf = reader(Node.prototype, 'nodeType');
  const textOf = reader(Node.prototype, 'textContent');
  const containsNode = method(Node.prototype, 'contains');
  const childrenOf = reader(Element.prototype, 'children');
  const idOf = reader(Element.prototype, 'id');
  const tagOf = reader(Element.prototype, 'localName');
  const classesOf = reader(Element.prototype, 'classList');
  const boxOf = method(Element.prototype, 'getBoundingClientRect');
  const attributeOf = method(Element.prototype, 'getAttribute');
  const closestTo = method(Element.prototype, 'closest');
  const matchesIn = method(Element.prototype, 'matches');
  const scrollTo = method(Element.prototype, 'scrollIntoView');
  const rootOf = reader(Document.prototype, 'documentElement');
  const bodyOf = reader(Document.prototype, 'body');
  const activeOf = reader(Document.prototype, 'activeElement');
  const find = method(Document.prototype, 'querySelector');
  const findAll = method(Document.prototype, 'querySelectorAll');
  const pointAt = method(Document.prototype, 'elementFromPoint');
  const walk = method(Document.prototype, 'createTreeWalker');
  const create = method(Document.prototype, 'createElement');
  const createNS = method(Document.prototype, 'createElementNS');
  const createText = method(Document.prototype, 'createTextNode');
  const maxDepth = 512;

  const host = create(document, 'div');
  // The top layer keeps the controls above the page's popovers. A manual popover closes none of them.
  host.popover = 'manual';
  const shadow = host.attachShadow({ mode: 'closed' });
  const stylesheet = new CSSStyleSheet();
  function element(tag, className, text) {
    const node = create(document, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(path) {
    const svg = createNS(document, 'http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const shape = createNS(document, svg.namespaceURI, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  }
  function mark() {
    const svg = createNS(document, 'http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('mark');
    const top = createNS(document, svg.namespaceURI, 'path');
    top.setAttribute('d', 'M4 11.5 18.5 4 29 9.4 14.5 17Z');
    top.setAttribute('fill', '#9478F7');
    const layers = createNS(document, svg.namespaceURI, 'path');
    layers.setAttribute('d', 'm4 16.1 10.5 5.5L29 14.1M4 21l10.5 5.5L29 19');
    layers.setAttribute('stroke', '#7050D1');
    layers.setAttribute('stroke-width', '3.2');
    layers.setAttribute('stroke-linejoin', 'round');
    layers.setAttribute('stroke-linecap', 'round');
    svg.append(top, layers);
    return svg;
  }
  const close = 'm6 6 12 12 M18 6 6 18';
  const refresh = 'M20 5v5h-5 M19 10a7.5 7.5 0 1 0 .2 5';
  const plus = 'M12 5v14 M5 12h14';
  const arrow = 'M6 18 18 6 M7 6h11v11';
  const pen = 'm4 17-.8 4 4-.9 12-12-3.2-3.2z M14.5 6.4l3.2 3.2';
  const ask = 'M12 21a9 9 0 1 0-8-4.9L3 21l4.6-1.2A9 9 0 0 0 12 21z M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.5-1.2 1-1.2 1.9 M12 16.6v.1';
  const camera = 'M4 8h3l1.5-2h7L17 8h3v11H4z M12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
  const copy = 'M9 9h11v11H9z M5 15V4h11';
  const prompts = {change: 'What should change?', question: 'What do you want to know?'};
  const contrast = 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 3v18 M12 8h7.9 M12 12h9 M12 16h7.9';
  const installGuide = 'https://github.com/lolabradora/nitpost#install-the-apple-silicon-beta';
  const shortcutSettings = 'chrome://extensions/shortcuts';
  const jpeg = 'data:image/jpeg;base64,';
  const maxReferenceChars = 120000;
  const maxGroup = 8;
  const minArea = 8;
  const modeKey = 'm';
  const agentNames = {codex: 'Codex', claude: 'Claude Code'};
  const routeNames = {...agentNames, tmux: 'tmux', rex: 'Rex'};

  const shield = element('div', 'shield');
  shield.hidden = true; // Until picking starts, the pointer keeps hovering the page.
  const outline = element('div', 'outline');
  const tagName = element('span', 'tag-name');
  const tagSize = element('span', 'tag-size');
  const tag = element('span', 'tag');
  tag.append(tagName, tagSize);
  outline.append(tag);
  const scrim = element('div', 'scrim');
  const marks = element('div', 'marks');
  const pins = element('div', 'pins');
  const editor = element('div', 'editor');
  editor.hidden = true;
  const dock = element('div', 'dock');
  dock.lang = 'en';
  const surface = element('div');
  const panels = element('div', 'panels');
  const status = element('p', 'status');
  const spoken = element('p', 'spoken');
  // Events on Nitpost's own controls stop here, so the page's document and bubble-phase window
  // listeners never see them. They are composed events: a capture listener the page put on the window
  // runs before this and still sees the key, click or paste, retargeted to the host element.
  const ownEvents = ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup',
    'click', 'dblclick', 'paste', 'copy', 'cut'];
  for (const type of ownEvents) {
    for (const layer of [pins, editor, dock]) layer.addEventListener(type, event => event.stopPropagation());
  }
  for (const region of [status, spoken]) {
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
  }
  dock.append(status, spoken, panels, surface);
  shadow.append(shield, outline, scrim, marks, pins, editor, dock);


  let page = location.href;
  let mode = 'idle';
  let notes = [];
  let target = null;
  let project = null;
  let recentProjects = [];
  let attempt = null;
  let shortcut = '';
  let draft = null;
  let busy = false;
  let orphaned = false;
  let previousFocus = null;
  let marked = null;
  let group = [];
  let pickMode = 'element';
  let corner = null;
  let press = null;
  let claimed = false;
  let pinned = [];
  let handledKey = null;
  let dim = true;
  let shown = null;
  let descent = [];
  let looping = false;
  let tick = 0;
  let spreadDue = false;
  let dockAt = {x: 0, y: 0};
  let drag = null;
  let gripped = false;
  let editorAnchor = null;
  let kept = [];
  let blocked = false;

  function px(value) {
    return Math.round(value * 100) / 100 + 'px';
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(value, high));
  }

  function plural(count, noun) {
    return count + ' ' + noun + (count === 1 ? '' : 's');
  }

  // Names a control or state for anything that drives the overlay from outside, such as a browser test.
  function control(node, name) {
    node.dataset.control = name;
    return node;
  }

  // Layout runs every frame, so a style is written only when its value changes.
  function write(node, styles) {
    let changed = false;
    for (const [name, value] of Object.entries(styles)) {
      if (node.style[name] === value) continue;
      node.style[name] = value;
      changed = true;
    }
    return changed;
  }

  function message(value = '', error = false) {
    status.textContent = value;
    status.classList.toggle('error', error);
  }

  // For screen readers, when the same words are already on screen in a panel.
  function announce(value) {
    spoken.textContent = value;
  }

  // The raw reply. Only a request the extension never answered throws.
  async function exchange(op, params = {}) {
    if (location.href !== page) throw new Error('The page changed. Reopen Nitpost here.');
    try {
      return await chrome.runtime.sendMessage({ op, page, ...params });
    } catch {
      // A reloaded or updated extension leaves this script without a runtime. Anything else is a
      // service worker that stopped mid-request: the extension and what it stored are still there.
      if (chrome.runtime?.id) throw new Error('Nitpost stopped before it answered. Try again.');
      orphaned = true;
      throw new Error('Nitpost disconnected. Reload this tab to reconnect.');
    }
  }

  async function request(op, params = {}) {
    const result = await exchange(op, params);
    if (!result?.ok) throw new Error(result?.error || 'The request failed. Try again.');
    return result;
  }

  async function loadState() {
    const currentPage = page;
    const state = await request('state');
    if (page !== currentPage) return;
    notes = state.notes;
    target = state.target;
    project = state.project || null;
    recentProjects = state.recentProjects || [];
    attempt = state.attempt || null;
    shortcut = state.shortcut || '';
    setDim(state.dim !== false);
    renderPins();
  }

  // Serialize deliberate actions. After navigation, a response belongs to the old surface.
  async function run(action) {
    const wasIdle = mode === 'idle';
    if (routeChanged() && !wasIdle) return;
    if (busy) return;
    const currentPage = page;
    busy = true;
    surface.setAttribute('aria-busy', 'true');
    try {
      await action();
    } catch (err) {
      if (currentPage !== page) return;
      // Without the extension the notes in memory are all there is. Keep them on screen and copyable.
      if (orphaned && mode === 'review') showReview();
      else message(err.message, true);
    } finally {
      if (currentPage === page) {
        surface.removeAttribute('aria-busy');
        busy = false;
      }
    }
  }

  function button(label, onClick, style = '', glyph = '') {
    const b = element('button', style);
    b.type = 'button';
    if (glyph) b.append(icon(glyph));
    if (style === 'icon') {
      b.title = label;
      b.setAttribute('aria-label', label);
    } else {
      b.append(createText(document, label));
    }
    b.addEventListener('click', event => {
      if (event.isTrusted) void run(onClick);
    });
    return b;
  }

  // Dimming separates the white controls from light pages. The choice is remembered.
  function setDim(on) {
    dim = on;
    scrim.hidden = !on;
    outline.toggleAttribute('data-flat', !on);
  }

  function dimToggle() {
    const toggle = button('Dim the page', async () => {
      setDim(!dim);
      toggle.setAttribute('aria-pressed', String(dim));
      await request('dim', {on: dim});
    }, 'icon', contrast);
    toggle.setAttribute('aria-pressed', String(dim));
    return toggle;
  }

  function focus(node) {
    queueMicrotask(() => {
      if (!node || !connected(node)) return;
      try {
        node.focus({ preventScroll: true });
      } catch {
        // The page's own element, focused before Nitpost opened, has its focus method replaced.
      }
    });
  }

  function setMode(next) {
    mode = next;
    const picking = next === 'pick';
    shield.hidden = !picking;
    shield.removeAttribute('data-pass');
    if (!picking) kept = [];
    marked = null;
    group = [];
    pickMode = 'element';
    corner = null;
    press = null;
    descent = [];
    editorAnchor = null;
    spreadDue = true;
    outline.hidden = true;
    outline.dataset.mode = next;
    pins.inert = next !== 'review';
    dock.dataset.mode = next;
    surface.replaceChildren();
    panels.replaceChildren();
    editor.replaceChildren();
    editor.hidden = true;
    renderMarks();
    message();
    announce('');
  }

  function idle(restore = false) {
    draft = null;
    setMode('idle');
    host.remove();
    if (restore && previousFocus && connected(previousFocus)) focus(previousFocus);
  }

  // Popovers the page opens later would otherwise cover the controls. Showing again moves the host on top.
  function raise() {
    if (!host.isConnected || !host.showPopover) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // The host then stays in the normal flow, above everything except the top layer.
    }
  }
  window.addEventListener('toggle', event => {
    if (event.target !== host && event.newState === 'open') raise();
  }, true);

  async function toggle() {
    routeChanged();
    if (busy) return;
    if (host.isConnected) {
      idle(true);
      return;
    }
    previousFocus = activeOf(document);
    await run(async () => {
      if (!shadow.adoptedStyleSheets.length) {
        const css = await fetch(chrome.runtime.getURL('overlay.css'));
        if (!css.ok) throw new Error('Reload Nitpost to open the picker.');
        stylesheet.replaceSync(await css.text());
        shadow.adoptedStyleSheets = [stylesheet];
        void loadFont();
      }
      rootOf(document).append(host);
      raise();
      follow();
      let failure = null;
      try {
        await loadState();
      } catch (err) {
        failure = err;
      }
      if (!host.isConnected) return;
      if (failure || !notes.length) pick();
      else showReview();
      if (failure) throw failure;
    });
  }

  // Bytes are not subject to the page's font-src policy. The system font remains when Geist cannot load.
  async function loadFont() {
    try {
      const file = await fetch(chrome.runtime.getURL('fonts/geist-latin.woff2'));
      if (!file.ok) return;
      const face = new FontFace('Nitpost Geist', await file.arrayBuffer(), {weight: '100 900'});
      document.fonts.add(await face.load());
    } catch {
      return;
    }
  }

  // A modal dialog makes everything outside it inert, Nitpost's controls included.
  function modalOpen() {
    try {
      return Boolean(find(document, 'dialog:modal'));
    } catch {
      return false;
    }
  }

  // The dialog's own content can still be picked, and its screenshot is taken at that moment. Writing
  // the note has to wait until the dialog closes, because the editor is inert as long as it is open.
  function watchModal() {
    const now = mode !== 'idle' && modalOpen();
    if (now === blocked) return;
    blocked = now;
    if (!blocked) {
      message();
      if (mode === 'edit') focus(editor.querySelector('textarea'));
    } else if (mode === 'edit') {
      message('The page’s dialog blocks this editor. Close the dialog, for example with Esc, then write your '
        + 'note. The screenshot is already taken.', true);
    } else {
      message('A dialog on this page blocks Nitpost’s buttons until it closes. You can still pick inside '
        + 'the dialog: click an element, or press Tab, then Enter.', true);
    }
  }

  // What the pointer rests on when picking starts without a click on Nitpost, as it does after the
  // keyboard shortcut. A menu that only exists while hovered must keep its hover to be picked.
  function hovered() {
    const limit = window.innerWidth * window.innerHeight * 0.35;
    return [...findAll(document, ':hover')].filter(node => {
      if (node === host || node === rootOf(document) || node === bodyOf(document)) return false;
      const rect = boxOf(node);
      return rect.width * rect.height <= limit;
    });
  }

  function pick() {
    const resting = hovered();
    setMode('pick');
    kept = resting;
    shield.toggleAttribute('data-pass', kept.length > 0);
    renderPickBar(true);
    if (activeOf(document) === host) host.blur();
    blocked = false;
    watchModal();
  }

  const pickWords = {
    element: {
      name: 'Element',
      lead: 'Click an element to annotate',
      keys: 'to pick',
      spoken: 'Click an element, or press Tab to reach one, then Enter. Arrow up and arrow down widen or '
        + 'narrow the selection. Drag to mark an area. Shift-click adds elements to one shared note. '
        + 'Press M to switch between Element, Several and Area.',
    },
    area: {
      name: 'Area',
      lead: 'Drag over an area, or click two corners',
      keys: 'uses the focused element’s box',
      spoken: 'Drag over an area, or click two opposite corners. By keyboard an area is the box of the '
        + 'focused element: press Tab to reach one, then Enter. Press M to switch mode.',
    },
    group: {
      name: 'Several',
      lead: 'Click 2 to 8 elements for one note',
      keys: 'to add or remove',
      spoken: 'Click each element that belongs to the note, 2 to 8 in all. Click one again to deselect it. '
        + 'By keyboard, press Tab to reach each one, then Enter, and Command Enter or Control Enter to '
        + 'write the note. Press M to switch mode.',
    },
  };

  function pickLead() {
    if (pickMode === 'area' && corner) return 'Now click the opposite corner';
    if (pickMode === 'group' && group.length) return group.length + ' of ' + maxGroup + ' selected';
    return pickWords[pickMode].lead;
  }

  // The shortcut opens Nitpost without a click on the toolbar, which would close a menu that closes on blur.
  function shortcutHint() {
    if (!shortcut) {
      return control(button('Set a shortcut', async () => {
        const copied = await copyText(shortcutSettings, 'The address of Chrome’s shortcut settings');
        message((copied ? 'Copied ' + shortcutSettings + '. Paste it in the address bar' : 'Open ' + shortcutSettings)
          + ' and choose a key for Nitpost. A shortcut opens it without closing an open menu.');
      }, 'quiet'), 'set-shortcut');
    }
    const hint = element('span', 'hint shortcut-hint');
    hint.append(element('span', 'key shortcut-key', shortcut), element('span', '', 'opens this'));
    hint.title = 'Opens and closes Nitpost. Open menus stay open. Change the key at ' + shortcutSettings + '.';
    return hint;
  }

  function keyHint(words, ...keys) {
    const hint = element('span', 'hint');
    hint.append(...keys.map(key => element('span', 'key', key)), element('span', '', words));
    return hint;
  }

  // `full` reads the whole instruction to a screen reader, as on entering a mode. Otherwise only
  // the line that changed is spoken, such as the count of selected elements.
  function renderPickBar(full = false) {
    const bar = element('div', 'pickbar');
    bar.dataset.pick = pickMode;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Nitpost picker');
    const instructions = element('div', 'instructions');
    const keyboard = control(keyHint(pickWords[pickMode].keys, 'Tab', '↵'), 'keyboard-hint');
    instructions.append(element('strong', '', pickLead()), keyboard);
    if (pickMode !== 'area') instructions.append(keyHint('widen or narrow', '↑', '↓'));
    instructions.append(control(keyHint('next mode', modeKey.toUpperCase()), 'mode-key'));
    announce(full ? pickLead() + '. ' + pickWords[pickMode].spoken : pickLead());
    const modes = element('div', 'segmented');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'What to select');
    for (const [id, words] of Object.entries(pickWords)) {
      const segment = control(button(words.name, () => setPickMode(id), 'segment'), 'pick-' + id);
      segment.setAttribute('aria-pressed', String(id === pickMode));
      modes.append(segment);
    }
    const exit = button('Esc', back, 'key');
    exit.setAttribute('aria-label', 'Exit annotation mode');
    bar.append(mark(), instructions, modes);
    if (pickMode === 'group') {
      const done = control(button('Write note', finishGroup, 'btn primary'), 'group-done');
      done.disabled = group.length < 2;
      bar.append(done);
    }
    if (notes.length) bar.append(control(button('Review ' + noteCount(), () => review(), 'btn secondary'), 'review'));
    else if (attempt) bar.append(control(button('Last send', () => review(), 'btn secondary'), 'review'));
    bar.append(shortcutHint(), dimToggle(), exit);
    surface.replaceChildren(bar);
  }

  function setPickMode(next) {
    pickMode = next;
    corner = null;
    if (next !== 'group') group = [];
    highlight(null);
    renderMarks();
    message();
    renderPickBar(true);
  }

  function underPointer(event) {
    shield.style.pointerEvents = 'none';
    const node = pointAt(document, event.clientX, event.clientY);
    shield.style.pointerEvents = '';
    return node === host ? null : node;
  }

  function noteCount() {
    return plural(notes.length, 'note');
  }

  // An area is a rectangle in document coordinates, so it scrolls with the page like an element does.
  function rectOf(item) {
    const area = areaOf(item);
    if (!area) return boxOf(item);
    return new DOMRect(area.x - window.scrollX, area.y - window.scrollY, area.width, area.height);
  }

  // A selection target is a page element or an {area} object Nitpost made. Only the latter has an area.
  function areaOf(item) {
    return item && !(item instanceof Node) ? item.area : null;
  }

  function alive(item) {
    return Boolean(item) && (Boolean(areaOf(item)) || connected(item));
  }

  function union(rects) {
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    return new DOMRect(left, top, Math.max(...rects.map(rect => rect.right)) - left,
      Math.max(...rects.map(rect => rect.bottom)) - top);
  }

  // What the selection covers on screen right now: the marked target, or every element of a group.
  function selectionRect() {
    const targets = marked ? [marked] : group;
    const rects = targets.filter(alive).map(rectOf).filter(rect => rect.width || rect.height);
    return rects.length ? union(rects) : null;
  }

  // Pointer and focus start a fresh selection. Arrow keys keep the path back down to it.
  function highlight(node, keepPath = false) {
    if (!keepPath) descent = [];
    const usable = areaOf(node) || (node instanceof Element && node !== host && node !== rootOf(document));
    marked = usable ? node : null;
    place(true);
  }

  // A newly marked element glides into place. One that moves with the page is followed exactly.
  function place(glide = false) {
    const rect = alive(marked) ? rectOf(marked) : null;
    // A closed menu leaves its items connected but without a box.
    if (!rect || !(rect.width || rect.height)) {
      outline.hidden = true;
      shown = null;
      return;
    }
    const area = areaOf(marked);
    outline.classList.toggle('glide', glide && !area);
    const moved = write(outline, {
      left: px(rect.left), top: px(rect.top), width: px(rect.width), height: px(rect.height),
    });
    if (!moved && shown === marked && !outline.hidden) return;
    shown = marked;
    tagName.textContent = area ? 'area' : tagOf(marked) + tagSuffix(marked);
    tagSize.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
    outline.dataset.tag = rect.top < 30 || rect.left < 6 ? 'inside' : 'above';
    outline.hidden = false;
  }

  function tagSuffix(node) {
    const id = idOf(node);
    const first = classesOf(node)[0];
    return id ? '#' + id : first ? '.' + first : '';
  }

  // Every element of a group keeps its own numbered outline.
  function renderMarks() {
    marks.replaceChildren(...group.map((node, index) => {
      const box = element('div', 'mark-box');
      box.append(element('span', '', String(index + 1)));
      return box;
    }));
    placeMarks();
  }

  function placeMarks() {
    group.forEach((node, index) => {
      const box = marks.children[index];
      const rect = alive(node) ? rectOf(node) : null;
      const visible = Boolean(rect && (rect.width || rect.height));
      if (box.hidden === visible) box.hidden = !visible;
      if (visible) write(box, {left: px(rect.left), top: px(rect.top), width: px(rect.width), height: px(rect.height)});
    });
  }

  // The page can reflow without scrolling, so positions are checked on every frame while open.
  function frame() {
    if (!host.isConnected) {
      looping = false;
      // The page removed the overlay, for example with document.open(). Stop picking with it.
      if (mode !== 'idle') idle();
      return;
    }
    tick++;
    if (!outline.classList.contains('glide') || shown !== marked) place();
    else followGlide();
    placeMarks();
    placePins();
    placeEditor();
    if (tick % 15 === 0) watchModal();
    if (dockAt.x || dockAt.y) moveDock(dockAt.x, dockAt.y);
    requestAnimationFrame(frame);
  }

  // While the outline glides, its target only cancels the glide by moving again.
  function followGlide() {
    const rect = alive(marked) ? rectOf(marked) : null;
    if (!rect || outline.style.left !== px(rect.left) || outline.style.top !== px(rect.top)
        || outline.style.width !== px(rect.width) || outline.style.height !== px(rect.height)) place();
  }

  function follow() {
    if (looping) return;
    looping = true;
    requestAnimationFrame(frame);
  }

  // Notes saved by earlier versions have no scope and are element notes.
  function scopeOf(note) {
    return note.scope === 'area' || note.scope === 'group' ? note.scope : 'element';
  }

  // Today reads as a time. Any other day needs its date.
  function when(at) {
    const date = new Date(at);
    const today = date.toDateString() === new Date().toDateString();
    const format = today ? {timeStyle: 'short'} : {dateStyle: 'medium', timeStyle: 'short'};
    const text = new Intl.DateTimeFormat(undefined, format).format(date);
    return {text, phrase: (today ? 'at ' : 'on ') + text, iso: date.toISOString()};
  }

  // Only these may already be in the conversation. The user decides before anything is sent again.
  function uncertain(record) {
    return ['pending', 'unconfirmed', 'unknown'].includes(record?.status);
  }

  function attempted(note) {
    return Boolean(attempt?.ids?.includes(note.id)) && (uncertain(attempt) || attempt.status === 'failed');
  }

  const attemptLabels = {unconfirmed: 'Posted, no receipt', unknown: 'Send result unknown',
    pending: 'Send result unknown', failed: 'Not sent'};

  function noteMeta(note) {
    const parts = [];
    if (note.kind === 'question') parts.push('Question');
    if (scopeOf(note) === 'area') parts.push('Area ' + note.rect.width + ' × ' + note.rect.height);
    if (scopeOf(note) === 'group') parts.push(plural(note.elements.length, 'element'));
    const meta = element('p', 'card-meta');
    meta.append(...parts.map(part => element('span', '', part)));
    if (attempted(note)) meta.append(element('span', 'sent', attemptLabels[attempt.status]));
    const images = [note.shot && imageWords.current.name, note.ref && imageWords.reference.name].filter(Boolean);
    if (images.length) {
      const attached = element('span', 'shot');
      attached.append(icon(camera), images.join(' + '));
      attached.setAttribute('aria-label', 'Images attached: ' + images.join(' and ').toLowerCase());
      meta.append(attached);
    }
    return meta.childElementCount ? meta : null;
  }

  // Saved selectors come from storage. One that no longer parses or matches has no element to mark.
  function locate(selector) {
    try {
      return find(document, selector);
    } catch {
      return null;
    }
  }

  function selectorsOf(note) {
    if (scopeOf(note) === 'area') return [];
    return scopeOf(note) === 'group' ? note.elements.map(item => item.selector) : [note.selector];
  }

  // Marks what a note points at: its element, its area, or each element of its group.
  function aim(note) {
    if (scopeOf(note) === 'area') {
      highlight({area: note.rect});
      return;
    }
    const nodes = selectorsOf(note).map(locate).filter(Boolean);
    if (scopeOf(note) === 'group') {
      group = nodes;
      renderMarks();
    } else {
      highlight(nodes[0] ?? null);
    }
  }

  function unaim() {
    highlight(null);
    group = [];
    renderMarks();
  }

  // The two images of a note answer different questions, so each always appears under its own name.
  const imageWords = {
    current: {name: 'Page now', label: 'Screenshot of the page as it is now', none: 'No screenshot'},
    reference: {name: 'Wanted result', label: 'Reference image of the wanted result', none: 'No reference image'},
  };

  // The page's policy can block data: images and fetches, but not bytes decoded here.
  async function paint(canvas, url, tile) {
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    // A wide strip, such as a heading, is unreadable at half the width.
    tile.toggleAttribute('data-wide', bitmap.width > bitmap.height * 3);
    bitmap.close();
    spreadDue = true;
  }

  function thumb(data, words, tile) {
    const zoom = control(element('button', 'thumb'), 'zoom');
    zoom.type = 'button';
    zoom.setAttribute('aria-label', 'Enlarge: ' + words.label.toLowerCase());
    zoom.setAttribute('aria-expanded', 'false');
    const canvas = element('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    zoom.append(canvas);
    paint(canvas, data, tile).catch(() => zoom.replaceChildren(element('span', 'tile-empty', 'Preview unavailable')));
    zoom.addEventListener('click', event => {
      if (!event.isTrusted) return;
      zoom.setAttribute('aria-expanded', String(tile.toggleAttribute('data-zoom')));
      spreadDue = true;
    });
    return zoom;
  }

  // Shows a note's images side by side. `actions(which, data)` supplies the control under a tile, and
  // `only` leaves out a tile that has nothing to show.
  function gallery(model, actions, only = false) {
    const box = element('div', 'shots');
    function tile(which) {
      const words = imageWords[which];
      const data = which === 'current' ? model.image : model.reference;
      const omitted = which === 'current' && Boolean(model.omit);
      const figure = element('figure', 'tile');
      figure.dataset.image = which;
      figure.dataset.state = !data ? 'empty' : omitted ? 'omitted' : 'shown';
      figure.setAttribute('aria-label', words.label);
      if (data && !omitted) figure.append(thumb(data, words, figure));
      else figure.append(element('p', 'tile-empty', omitted ? 'Left out of this note' : words.none));
      const caption = element('figcaption');
      caption.append(element('strong', '', words.name));
      const action = actions(which, data);
      if (action) caption.append(action);
      figure.append(caption);
      return figure;
    }
    function render(refocus = '') {
      box.replaceChildren();
      box.toggleAttribute('aria-busy', Boolean(model.loading || model.busy));
      if (model.loading) {
        box.append(element('p', 'shots-note', 'Loading images…'));
      } else if (model.error) {
        box.append(element('p', 'shots-note error', model.error));
      } else {
        const tiles = ['current', 'reference'].filter(which => !only
          || (which === 'current' ? model.image : model.reference));
        box.append(...tiles.map(tile));
        if (model.busy) box.append(element('p', 'shots-note', 'Preparing the image…'));
        if (model.problem) {
          const problem = element('p', 'shots-note error', model.problem);
          problem.setAttribute('role', 'alert');
          box.append(problem);
        }
      }
      spreadDue = true;
      if (refocus) focus(box.querySelector('[data-control="' + refocus + '"]'));
    }
    render();
    return {box, render};
  }

  // A saved note's images are fetched only when someone asks to see them.
  async function loadImages(id, model, view) {
    const currentPage = page;
    try {
      const result = await request('images', {id});
      model.image = result.image;
      model.reference = result.reference;
    } catch (err) {
      model.error = err.message;
    }
    model.loading = false;
    if (currentPage === page && view.box.isConnected) view.render();
  }

  // In review a note's images open inside its card, where either one can be removed. The control sits
  // with the card's other actions, which appear on hover: nothing above them shifts under the pointer.
  function cardImages(note, index, actions) {
    let view = null;
    async function removeImage(which) {
      const originalPage = page;
      const change = which === 'current' ? {shot: false} : {reference: null};
      await request('edit', {id: note.id, comment: note.comment, kind: note.kind, ...change});
      if (originalPage !== page) return;
      await review();
      if (originalPage !== page) return;
      message('“' + imageWords[which].name + '” image removed from note ' + (index + 1) + '.');
    }
    const opener = control(button('Images', () => {
      if (view) {
        view.box.remove();
        view = null;
      } else {
        const model = {loading: true};
        view = gallery(model, (which, data) => data
          ? control(button('Remove', () => removeImage(which), 'quiet'), 'remove-' + which) : null, true);
        actions.before(view.box);
        void loadImages(note.id, model, view);
      }
      opener.setAttribute('aria-expanded', String(Boolean(view)));
      spreadDue = true;
    }, 'quiet'), 'images');
    opener.setAttribute('aria-expanded', 'false');
    actions.append(opener);
  }

  function noteBox(note, index) {
    const scope = scopeOf(note);
    const selectors = selectorsOf(note);
    const area = scope === 'area' ? note.rect : null;
    const item = {id: note.id, selectors, nodes: selectors.map(locate), area, shift: 0};
    const open = () => edit(note, true);
    const pin = button(String(index + 1), open, 'pin');
    const about = {element: '', area: ', on an area',
      group: ', on ' + plural(note.elements?.length ?? 0, 'element')}[scope];
    pin.setAttribute('aria-label', 'Edit note ' + (index + 1) + about);
    const actions = element('div', 'card-actions');
    actions.append(button('Edit', open, 'quiet'), button('Remove', async () => {
      const originalPage = page;
      await request('remove', {id: note.id});
      if (originalPage === page) await review();
    }, 'quiet'));
    item.lost = element('p', 'lost', (scope === 'group' ? 'Elements' : 'Element') + ' not found on this page');
    item.lost.hidden = true;
    item.card = element('div', 'card');
    item.card.append(item.lost, element('p', 'comment', note.comment));
    const meta = noteMeta(note);
    if (meta) item.card.append(meta);
    item.card.append(actions);
    if (note.shot || note.ref) cardImages(note, index, actions);
    item.box = element('div', 'note');
    item.box.dataset.scope = scope;
    if (attempted(note)) item.box.dataset.attempt = attempt.status === 'pending' ? 'unknown' : attempt.status;
    item.box.append(pin, item.card);
    for (const type of ['pointerenter', 'focusin']) {
      item.box.addEventListener(type, () => mode === 'review' && aim(note));
    }
    for (const type of ['pointerleave', 'focusout']) {
      item.box.addEventListener(type, () => mode === 'review' && unaim());
    }
    return item;
  }

  // Each saved note stays on the page as a numbered pin and comment card at its element.
  function renderPins() {
    pinned = notes.map(noteBox);
    pins.replaceChildren(...pinned.map(item => item.box));
    spreadDue = true;
    placePins();
  }

  // Where a note's pin belongs: its area, or the first of its elements that is rendered.
  function pinRect(item) {
    if (item.area) return rectOf(item);
    for (const node of item.nodes) {
      const rect = node && connected(node) ? boxOf(node) : null;
      if (rect && (rect.width || rect.height)) return rect;
    }
    return null;
  }

  // Notes whose element is missing or not rendered stack at the lower left so they stay editable.
  // An element the page adds later is found again within half a second.
  function placePins() {
    let lost = 0;
    const retry = tick % 30 === 0;
    for (const item of pinned) {
      if (retry) item.nodes = item.nodes.map((node, index) => node && connected(node) ? node : locate(item.selectors[index]));
      const rect = pinRect(item);
      const found = Boolean(rect);
      const left = found ? clamp(rect.left, 14, window.innerWidth - 14) : 28;
      const top = found ? clamp(rect.top, 14, window.innerHeight - 14) : window.innerHeight - 130 - 72 * lost++;
      const side = left > window.innerWidth - 300 ? 'left' : 'right';
      if (write(item.box, {left: px(left), top: px(top)})) spreadDue = true;
      if (item.box.dataset.side !== side) item.box.dataset.side = side;
      if (item.lost.hidden === found) continue;
      item.lost.hidden = found;
      spreadDue = true;
    }
    if (spreadDue) spread();
  }

  // Cards that would cover each other move down, staying above the bar where they can.
  function spread() {
    spreadDue = false;
    const bar = dock.getBoundingClientRect();
    const cards = [];
    for (const item of pinned) {
      const rect = item.card.getBoundingClientRect();
      if (rect.height) cards.push({item, left: rect.left, right: rect.right, top: rect.top - item.shift, height: rect.height});
    }
    cards.sort((a, b) => a.top - b.top);
    const placed = [];
    for (const card of cards) {
      let top = card.top;
      for (const other of placed) {
        const beside = card.left < other.right + 6 && other.left < card.right + 6;
        if (beside && top < other.bottom + 6 && other.top < top + card.height + 6) top = other.bottom + 6;
      }
      top = clamp(top, 8, Math.max(8, window.innerHeight - 8 - card.height));
      const overBar = card.left < bar.right && bar.left < card.right
        && top < bar.bottom + 6 && bar.top < top + card.height + 6;
      const below = bar.bottom + 8;
      const roomBelow = below + card.height <= window.innerHeight - 8;
      if (overBar) top = bar.top > window.innerHeight / 2 || !roomBelow ? Math.max(8, bar.top - 8 - card.height) : below;
      placed.push({left: card.left, right: card.right, top, bottom: top + card.height});
      card.item.shift = top - card.top;
      write(card.item.card, {translate: '0px ' + px(card.item.shift)});
    }
  }

  // The note editor sits under its selection, or above it when the viewport or the bar is in the way.
  // A selection that loses its box, such as an item of a menu that closed, leaves the editor where it was.
  function placeEditor() {
    if (editor.hidden) return;
    const width = editor.offsetWidth;
    const height = editor.offsetHeight;
    editorAnchor = selectionRect() ?? editorAnchor;
    const rect = editorAnchor;
    const left = clamp(rect ? rect.left - 6 : (window.innerWidth - width) / 2, 12, window.innerWidth - width - 12);
    const bar = dock.getBoundingClientRect();
    const overBar = bar.height > 8 && bar.top > window.innerHeight / 2 && left < bar.right && bar.left < left + width;
    const floor = (overBar ? bar.top : window.innerHeight) - 12;
    let top = rect ? rect.bottom + 14 : floor - height;
    if (rect && top + height > floor) top = rect.top - height - 14;
    write(editor, {top: px(clamp(top, 12, Math.max(12, floor - height))), left: px(left)});
  }

  // The bar can be dragged out of the way. It stays inside the viewport and returns on a double-click.
  function moveDock(x, y) {
    const rect = dock.getBoundingClientRect();
    const left = rect.left - dockAt.x;
    const top = rect.top - dockAt.y;
    const next = {
      x: Math.round(clamp(x, 8 - left, window.innerWidth - 8 - left - rect.width)),
      y: Math.round(clamp(y, 8 - top, window.innerHeight - 8 - top - rect.height)),
    };
    if (next.x === dockAt.x && next.y === dockAt.y) return;
    dockAt = next;
    dock.style.translate = next.x || next.y ? 'calc(-50% + ' + next.x + 'px) ' + next.y + 'px' : '';
    spreadDue = true;
  }

  dock.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0 || !surface.contains(event.target)) return;
    if (event.target.closest('button, select')) return;
    drag = {x: event.clientX - dockAt.x, y: event.clientY - dockAt.y};
    gripped = Boolean(event.target.closest('.mark'));
    dock.setPointerCapture(event.pointerId);
    dock.toggleAttribute('data-dragging', true);
    event.preventDefault();
  });
  dock.addEventListener('pointermove', event => {
    if (drag && event.isTrusted) moveDock(event.clientX - drag.x, event.clientY - drag.y);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    dock.addEventListener(type, () => {
      drag = null;
      dock.removeAttribute('data-dragging');
    });
  }
  // Pointer capture retargets the double-click to the dock, so the press records where it began.
  dock.addEventListener('dblclick', event => {
    if (event.isTrusted && gripped) moveDock(0, 0);
  });
  // A click on the picker bar must not take focus from the page: a menu that closes on blur would close.
  dock.addEventListener('mousedown', event => {
    if (mode === 'pick' && event.target.closest('button')) event.preventDefault();
  });

  // Use unique IDs where available. Otherwise retain the structural path to the element.
  // Null when the element sits deeper than any real page nests.
  function selectorFor(node) {
    const parts = [];
    let depth = 0;
    for (let el = node; el; el = parentOf(el)) {
      if (++depth > maxDepth) return null;
      const id = idOf(el);
      if (id) {
        const byId = '#' + CSS.escape(id);
        if (findAll(document, byId).length === 1) {
          parts.unshift(byId);
          break;
        }
      }
      const tag = tagOf(el);
      let part = CSS.escape(tag);
      const parent = parentOf(el);
      if (parent) {
        const sameTag = [...childrenOf(parent)].filter(sibling => tagOf(sibling) === tag);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  // Collect a short excerpt, skipping editable descendants and their values.
  function excerptOf(node) {
    const editable = closestTo(node, 'input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    let excerpt = attributeOf(node, 'aria-label') || attributeOf(node, 'alt') || '';
    if (!editable && !excerpt) {
      const walker = walk(document, node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(child) {
          if (kindOf(child) === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          if (matchesIn(child, 'input, textarea, select, [contenteditable], script, style, template, [hidden]')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      });
      let part;
      let visited = 0;
      while (excerpt.length < 180 && visited++ < 500 && (part = walker.nextNode())) {
        excerpt += ' ' + textOf(part).trim().slice(0, 180);
      }
    }
    return excerpt.trim().replace(/\s+/g, ' ').slice(0, 180);
  }

  // The selector and excerpt a note stores for an element, or null with the reason on screen.
  function describe(node) {
    if (!(node instanceof Element) || node === host) return null;
    const selector = selectorFor(node);
    if (selector === null) {
      message('This element is nested too deeply to describe. Pick one of its ancestors instead.', true);
      return null;
    }
    if (selector.length > 2048) {
      message('This element has a long selector. Pick its parent instead.', true);
      return null;
    }
    return {selector, text: excerptOf(node)};
  }

  function noteId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }

  // The part of a box that is on screen, which is all a screenshot can show.
  function visiblePart(rect) {
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const width = Math.min(window.innerWidth, rect.right) - x;
    const height = Math.min(window.innerHeight, rect.bottom) - y;
    return width >= 1 && height >= 1 ? {x, y, width, height} : null;
  }

  // The screenshot shows the page as the reviewer saw it, without Nitpost on top.
  async function capture(crop) {
    host.toggleAttribute('data-capture', true);
    try {
      await new Promise(done => {
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 250); // A tab that stops painting must not block the note.
      });
      const rect = visiblePart(crop());
      if (!rect) return null;
      const result = await request('capture', {rect, dpr: window.devicePixelRatio,
        width: window.innerWidth, height: window.innerHeight});
      return result.image || null;
    } catch {
      return null; // A note is worth writing without its screenshot.
    } finally {
      host.removeAttribute('data-capture');
    }
  }

  // The crop is taken as the selection is made, before the editor takes focus: a menu that closes on
  // blur is still open, and the user sees what will be sent before writing the note.
  async function start(fields, crop) {
    const currentPage = page;
    const image = await capture(crop);
    if (page !== currentPage || mode !== 'pick') return;
    edit({id: noteId(), ...fields, width: window.innerWidth, height: window.innerHeight, comment: '', image}, false);
  }

  function choose(node) {
    if (routeChanged() || busy) return;
    const found = describe(node);
    if (!found) return;
    scrollTo(node, {block: 'nearest'});
    void run(() => start({scope: 'element', ...found}, () => boxOf(node)));
  }

  // An area stores where it is in the document and never a selector.
  function chooseArea(view) {
    if (routeChanged() || busy) return;
    corner = null;
    if (view.width < minArea || view.height < minArea) {
      highlight(null);
      renderPickBar();
      message('That area is too small to describe. Mark at least ' + minArea + ' by ' + minArea + ' pixels.', true);
      return;
    }
    const rect = {
      // On a right-to-left page the document's left edge is at a negative offset.
      x: Math.round(view.left + window.scrollX), y: Math.round(view.top + window.scrollY),
      width: Math.round(view.width), height: Math.round(view.height),
    };
    highlight({area: rect});
    void run(() => start({scope: 'area', rect}, () => rectOf({area: rect})));
  }

  function toggleGroup(node) {
    if (routeChanged() || busy || !(node instanceof Element) || node === host || node === rootOf(document)) return;
    message();
    if (group.includes(node)) {
      group = group.filter(member => member !== node);
    } else if (group.length >= maxGroup) {
      message('One note covers up to ' + maxGroup + ' elements. Deselect one to add another.', true);
      return;
    } else if (describe(node)) {
      group = [...group, node];
    } else {
      return;
    }
    pickMode = 'group';
    highlight(null);
    renderMarks();
    renderPickBar();
  }

  // The screenshot of a group is the box around all of its elements.
  async function finishGroup() {
    const members = group.filter(connected);
    if (members.length < 2) {
      message('Select at least 2 elements, or switch to Element for a note on one.', true);
      return;
    }
    const elements = members.map(describe);
    if (elements.includes(null)) return;
    await start({scope: 'group', elements}, () => union(members.map(node => boxOf(node))));
  }

  function selectable(selector) {
    try {
      return CSS.supports('selector(' + selector + ')');
    } catch {
      return false;
    }
  }
  const openPopover = selectable(':popover-open') ? ':popover-open' : null;

  // The page node a pointer event in pick mode refers to. Undefined means the event is not the picker's:
  // it is on Nitpost's own controls. Page nodes get events directly while the shield lets them through.
  function pointed(event) {
    if (mode !== 'pick' || !event.isTrusted || !host.isConnected) return undefined;
    if (event.target !== host) return event.target instanceof Element ? event.target : null;
    // Enter or Space on one of Nitpost's buttons makes a click at 0,0 with no pointer behind it.
    // Its coordinates say nothing about where it happened, so it is never a pick.
    if (event.type === 'click' && event.detail === 0) return undefined;
    if (shadow.elementFromPoint(event.clientX, event.clientY) !== shield) return undefined;
    return underPointer(event);
  }

  // A click on the shield counts as a click outside an auto popover and closes it on release. Over one,
  // the shield steps aside so the click lands inside the popover, where the listeners below take it.
  // It also stays aside over what was hovered when picking began, until the pointer leaves that.
  function yieldTo(node) {
    if (kept.length && !(node && kept.some(item => containsNode(item, node)))) kept = [];
    const through = kept.length > 0 || Boolean(openPopover && node && closestTo(node, openPopover));
    if (shield.hasAttribute('data-pass') !== through) shield.toggleAttribute('data-pass', through);
  }

  function dragRect(event) {
    const left = Math.min(press.x, event.clientX);
    const top = Math.min(press.y, event.clientY);
    return new DOMRect(left, top, Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y));
  }

  // The first corner is kept in document coordinates, so the page can be scrolled before the second.
  function cornerRect(event) {
    const x = event.clientX + window.scrollX;
    const y = event.clientY + window.scrollY;
    return new DOMRect(Math.min(corner.x, x) - window.scrollX, Math.min(corner.y, y) - window.scrollY,
      Math.abs(x - corner.x), Math.abs(y - corner.y));
  }

  function showArea(view) {
    marked = {area: {x: view.left + window.scrollX, y: view.top + window.scrollY, width: view.width, height: view.height}};
    place();
  }

  // Pick-mode pointer handling lives on the window so the page's own document listeners never see a pick.
  window.addEventListener('pointerdown', event => {
    claimed = pointed(event) !== undefined && event.button === 0;
    if (!claimed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!busy) press = {x: event.clientX, y: event.clientY, dragging: false};
  }, true);

  window.addEventListener('pointermove', event => {
    if (mode !== 'pick' || !event.isTrusted || !host.isConnected) return;
    if (press) {
      const far = Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6;
      if (!press.dragging && far && pickMode !== 'group') {
        press.dragging = true;
        corner = null;
      }
      if (press.dragging) showArea(dragRect(event));
      return;
    }
    const node = pointed(event);
    if (node === undefined) return;
    yieldTo(node);
    if (corner) showArea(cornerRect(event));
    else if (pickMode === 'area') highlight(null);
    else if (node !== (descent[0] ?? marked)) highlight(node);
  }, true);

  function release(event) {
    const dragged = press.dragging ? dragRect(event) : null;
    press = null;
    if (mode !== 'pick' || busy) return;
    // A hand that slips a few pixels during a click in Element mode meant the element, not a tiny area.
    const slip = dragged && pickMode === 'element' && (dragged.width < minArea || dragged.height < minArea);
    if (dragged && !slip) {
      chooseArea(dragged);
    } else if (pickMode !== 'area') {
      const node = pointed(event);
      if (pickMode === 'group' || event.shiftKey) toggleGroup(node);
      else choose(node);
    } else if (corner) {
      chooseArea(cornerRect(event));
    } else {
      corner = {x: event.clientX + window.scrollX, y: event.clientY + window.scrollY};
      renderPickBar();
    }
  }

  window.addEventListener('pointerup', event => {
    if (!claimed || !press || !host.isConnected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    release(event);
  }, true);

  window.addEventListener('pointercancel', () => {
    if (press?.dragging) highlight(null);
    press = null;
  }, true);

  // The mouse events and the click that follow a claimed press belong to the pick, not to the page.
  // A click made with the keyboard has no press before it and stays with whatever it was aimed at.
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick']) {
    window.addEventListener(type, event => {
      const keyboard = type === 'click' && event.detail === 0 && event.target === host;
      const ours = event.isTrusted && host.isConnected && !keyboard && (claimed || pointed(event) !== undefined);
      if (type === 'click') claimed = false;
      if (!ours) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  // Leaving the window ends the hover. A corner or a drag in progress keeps its rectangle.
  window.addEventListener('pointerout', event => {
    if (mode === 'pick' && !event.relatedTarget && !press && !corner) highlight(null);
  }, true);

  function kindControl(current, onChange) {
    const group = element('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Note type');
    const segments = [['change', 'Change', pen], ['question', 'Question', ask]].map(([kind, label, glyph]) => {
      const segment = button(label, () => select(kind), 'segment', glyph);
      segment.dataset.kind = kind;
      return segment;
    });
    function select(kind) {
      for (const segment of segments) segment.setAttribute('aria-pressed', String(segment.dataset.kind === kind));
      onChange(kind);
    }
    select(current);
    group.append(...segments);
    return group;
  }

  // Shrinks a pasted or chosen image until its JPEG fits what one note may carry.
  async function encodeReference(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Chrome could not read that file as an image. Use a PNG, JPEG or WebP.');
    }
    try {
      for (const [longest, quality] of [[1280, 0.8], [1024, 0.7], [800, 0.6], [640, 0.5], [480, 0.45], [320, 0.4]]) {
        const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
        const canvas = element('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = 'white'; // JPEG has no transparency.
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.startsWith(jpeg) && url.length <= maxReferenceChars) return url;
      }
    } finally {
      bitmap.close();
    }
    throw new Error('This image is too detailed to attach, even at 320 pixels wide. '
      + 'Crop it to the part that matters and add it again.');
  }

  // The editor's images: the captured page, which can be left out, and one reference the user adds.
  function draftImages(model) {
    const chooser = element('input');
    chooser.type = 'file';
    chooser.accept = 'image/*';
    chooser.hidden = true;
    chooser.tabIndex = -1;
    const view = gallery(model, (which, data) => {
      if (which === 'current') {
        if (!data) return null;
        return control(button(model.omit ? 'Put back' : 'Leave out', () => {
          model.omit = !model.omit;
          view.render('omit-screenshot');
          announce(model.omit ? 'The screenshot will not be saved or sent.' : 'The screenshot is part of the note again.');
        }, 'quiet'), 'omit-screenshot');
      }
      if (!data) return control(button('Add image', () => chooser.click(), 'quiet'), 'add-reference');
      return control(button('Remove', () => {
        model.reference = null;
        model.touched = true;
        view.render('add-reference');
        announce('Reference image removed.');
      }, 'quiet'), 'remove-reference');
    });
    async function attach(file, refocus = '') {
      if (model.busy || model.loading) return;
      const replacing = Boolean(model.reference);
      model.busy = true;
      model.problem = '';
      view.render();
      try {
        model.reference = await encodeReference(file);
        model.touched = true;
        announce(replacing ? 'Reference image replaced.' : 'Reference image added as the wanted result.');
      } catch (err) {
        model.problem = err.message;
      }
      model.busy = false;
      if (view.box.isConnected) view.render(refocus && model.reference ? refocus : '');
    }
    chooser.addEventListener('change', event => {
      const file = chooser.files[0];
      chooser.value = '';
      if (event.isTrusted && file) void attach(file, 'remove-reference');
    });
    return {view, chooser, attach};
  }

  // Only the fields of the note's own scope are stored. A screenshot or page text left out is not stored at all.
  function draftNote(comment) {
    const note = {id: draft.id, kind: draft.kind, comment, width: draft.width, height: draft.height, scope: scopeOf(draft)};
    const keep = text => draft.omitText ? '' : text;
    if (note.scope === 'area') note.rect = draft.rect;
    else if (note.scope === 'group') note.elements = draft.elements.map(item => ({selector: item.selector, text: keep(item.text)}));
    else Object.assign(note, {selector: draft.selector, text: keep(draft.text)});
    if (draft.images.image && !draft.images.omit) note.image = draft.images.image;
    if (draft.images.reference) note.reference = draft.images.reference;
    return note;
  }

  // A new note keeps the picker open for the next element. An edited note returns to the list.
  async function saveDraft(existing) {
    const currentPage = page;
    const comment = draft.comment.trim();
    if (!comment) return;
    if (existing) {
      const changes = {id: draft.id, comment, kind: draft.kind};
      if (draft.images.omit && draft.images.image) changes.shot = false;
      if (draft.images.touched) changes.reference = draft.images.reference;
      if (draft.omitText) changes.text = '';
      await request('edit', changes);
      if (page === currentPage) await review();
      return;
    }
    const note = draftNote(comment);
    const result = await request('add', {note});
    if (page !== currentPage) return;
    await loadState();
    if (page !== currentPage) return;
    pick();
    if (note.image && !result.shot) {
      message('Saved without the screenshot, because Chrome’s storage for Nitpost is full.');
    }
  }

  // The excerpt is page text. On a signed-in page it can hold exactly what the user wants to keep back,
  // so it has its own control. On a saved note the text is already stored, and saving removes it for good.
  function excerptRow(shown, omitted, existing, onToggle = null) {
    const row = element('div', 'excerpt-row');
    const line = element('p', 'excerpt', shown);
    row.dataset.state = 'shown';
    row.append(line);
    const verb = existing ? 'Remove' : 'Leave out';
    const toggle = control(button(verb, () => {
      draft.omitText = !draft.omitText;
      line.textContent = draft.omitText ? omitted : shown;
      row.dataset.state = draft.omitText ? 'omitted' : 'shown';
      toggle.lastChild.data = draft.omitText ? 'Put back' : verb;
      toggle.setAttribute('aria-label', (draft.omitText ? 'Put back' : verb) + ' the text from the page');
      onToggle?.();
      const gone = existing ? 'Saving this note removes the text from the page for good.'
        : 'The text from the page will not be saved or sent.';
      announce(draft.omitText ? gone : 'The text from the page is part of the note again.');
    }, 'quiet'), 'omit-excerpt');
    toggle.setAttribute('aria-label', verb + ' the text from the page');
    row.append(toggle);
    return row;
  }

  function groupContext(note, existing) {
    const list = element('ul', 'targets');
    list.setAttribute('aria-label', 'Selected elements');
    for (const item of note.elements) {
      const entry = element('li');
      const code = element('code', '', item.selector);
      code.title = item.selector;
      entry.append(code);
      if (item.text) entry.append(element('p', 'target-text', item.text));
      list.append(entry);
    }
    const summary = element('p', 'excerpt', 'One note for these ' + note.elements.length + ' elements.');
    if (!note.elements.some(item => item.text)) return [list, summary];
    const omitted = existing ? 'Their text is removed when you save.' : 'Their text is left out of this note.';
    return [list, summary, excerptRow('Their text is included, as shown above.', omitted,
      existing, () => list.toggleAttribute('data-text-omitted', Boolean(draft.omitText)))];
  }

  // What the note is about, above the comment field: a selector, an area's size and place, or a group.
  function contextOf(note, existing) {
    const scope = scopeOf(note);
    if (scope === 'area') {
      const {x, y, width, height} = note.rect;
      const context = element('code', '', 'area ' + width + ' × ' + height + ' at ' + x + ', ' + y);
      context.title = 'Width and height in CSS pixels, then the distance from the left and top of the page';
      return [context, element('p', 'excerpt', 'A region of the page. No element is attached to it.')];
    }
    if (scope === 'group') return groupContext(note, existing);
    const context = element('code', '', note.selector);
    context.title = note.selector;
    const omitted = existing ? 'Text removed when you save' : 'Text left out of this note';
    return note.text ? [context, excerptRow(note.text, omitted, existing)] : [context];
  }

  // Brings a saved note's target on screen before the editor opens next to it.
  function reveal(note) {
    if (scopeOf(note) !== 'area') {
      const node = locate(selectorsOf(note)[0]);
      if (node) scrollTo(node, {block: 'nearest'});
      return;
    }
    const view = rectOf({area: note.rect});
    if (view.bottom < 0 || view.top > window.innerHeight || view.right < 0 || view.left > window.innerWidth) {
      window.scrollTo(Math.max(0, note.rect.x - 40), Math.max(0, note.rect.y - 80));
    }
  }

  function edit(note, existing) {
    setMode('edit');
    const images = existing ? {loading: Boolean(note.shot || note.ref)} : {image: note.image || null};
    draft = {...note, kind: note.kind === 'question' ? 'question' : 'change', images};
    if (existing) reveal(note);
    aim(note);
    pinned.find(item => item.id === note.id)?.box.classList.add('editing');
    editor.dataset.scope = scopeOf(note);
    const input = element('textarea');
    input.id = 'nitpost-comment';
    input.setAttribute('aria-label', 'Comment');
    input.maxLength = 2000;
    input.value = draft.comment;
    const saveNote = () => saveDraft(existing);
    const save = control(button('Save note', saveNote, 'btn primary'), 'save');
    save.disabled = !input.value.trim();
    input.addEventListener('input', () => {
      draft.comment = input.value;
      save.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', event => {
      if (event.isTrusted && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && !save.disabled) {
        event.preventDefault();
        void run(saveNote);
      }
    });
    const kinds = kindControl(draft.kind, kind => {
      draft.kind = kind;
      input.placeholder = prompts[kind];
    });
    const pictures = draftImages(images);
    if (images.loading) void loadImages(note.id, images, pictures.view);
    // Text pastes into the comment as usual. An image on the clipboard becomes the reference.
    editor.onpaste = event => {
      const data = event.clipboardData;
      if (!event.isTrusted || !data || data.types.includes('text/plain')) return;
      const file = [...data.files].find(item => item.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      void pictures.attach(file);
    };
    const keys = element('span', 'shortcut');
    keys.append(element('span', 'key', '⌘'), element('span', 'key', '↵'), element('span', '', 'to save'));
    keys.setAttribute('aria-label', 'Press Command Enter to save');
    const actions = element('div', 'actions');
    actions.append(keys, control(button('Cancel', back, 'btn secondary'), 'cancel'), save);
    const pasteHint = element('p', 'paste-hint', 'Paste or add an image to show the result you want.');
    editor.append(...contextOf(note, existing), pictures.view.box, pictures.chooser, pasteHint, kinds, input, actions);
    editor.hidden = false;
    placeEditor();
    focus(input);
    blocked = false;
    watchModal();
  }

  // Leaving the picker or the editor returns to the saved notes when there are any.
  function back() {
    return notes.length ? review() : idle(true);
  }

  async function review(notice = '', details = false) {
    const currentPage = page;
    await loadState();
    if (currentPage === page) showReview(notice, details);
  }

  // Markdown fences a selector in more backticks than it contains.
  function codeSpan(value) {
    const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(ticks => ticks.length));
    const fence = '`'.repeat(longest + 1);
    return longest ? fence + ' ' + value + ' ' + fence : fence + value + fence;
  }

  function elementLine(item) {
    return codeSpan(item.selector) + (item.text ? ' with the text “' + item.text + '”' : '');
  }

  // Images never travel in the copied text, so each note says which ones stayed behind.
  function imageLine(note) {
    const subject = {element: 'the element as it is', area: 'the area as it is',
      group: 'the elements as they are'}[scopeOf(note)];
    const kept = [];
    if (note.shot) kept.push('a screenshot of ' + subject + ' now');
    if (note.ref) kept.push('a reference image of the wanted result');
    if (!kept.length) return '- Images: none.';
    const verbs = kept.length === 1 ? ' is kept in Nitpost and is' : ' are kept in Nitpost and are';
    return '- Images: ' + kept.join(' and ') + verbs + ' not included in this text.';
  }

  function noteMarkdown(note, index) {
    const kind = note.kind === 'question' ? 'Question' : 'Change request';
    const lines = ['## ' + (index + 1) + '. ' + kind, '', note.comment, ''];
    const scope = scopeOf(note);
    if (scope === 'area') {
      const {x, y, width, height} = note.rect;
      lines.push('- Area: ' + width + ' × ' + height + ' CSS px, starting ' + x + ' px from the left and ' + y
        + ' px from the top of the document. No element was selected.');
    } else if (scope === 'group') {
      lines.push('- Elements (one note for all ' + note.elements.length + '):');
      note.elements.forEach((item, at) => lines.push('  ' + (at + 1) + '. ' + elementLine(item)));
    } else {
      lines.push('- Element: ' + elementLine(note));
    }
    lines.push('- Viewport: ' + note.width + ' × ' + note.height + ' CSS px', imageLine(note));
    return lines.join('\n');
  }

  // Built from the notes already in memory, so it needs no helper, no destination and no extension.
  function notesMarkdown() {
    const head = ['# Page feedback', '', 'Page: ' + page,
      plural(notes.length, 'note') + ' written with Nitpost. Selectors are CSS selectors on that page.'];
    return [head.join('\n'), ...notes.map(noteMarkdown)].join('\n\n') + '\n';
  }

  // Shows text selected and ready for a manual copy, for pages where scripts may not write the clipboard.
  function copyBox(text, lead) {
    const box = element('section', 'copybox');
    const area = element('textarea', 'copy-text');
    area.readOnly = true;
    area.value = text;
    area.setAttribute('aria-label', 'Text to copy');
    const actions = element('div', 'panel-actions');
    actions.append(control(button('Done', () => {
      box.remove();
      spreadDue = true;
    }, 'btn secondary'), 'copy-done'));
    box.append(element('p', 'panel-title', lead), area, actions);
    return {box, area};
  }

  // The async clipboard does not exist on insecure pages and refuses an unfocused document.
  // A selection inside the shadow tree still copies. Failing that, the text stays selected for the user.
  async function copyText(text, subject) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection.
    }
    const active = shadow.activeElement;
    const fallback = copyBox(text, subject + ' is selected below. Press ⌘C to copy it (Ctrl+C on Windows and Linux).');
    panels.append(fallback.box);
    fallback.area.focus({preventScroll: true});
    fallback.area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (!copied) return false;
    fallback.box.remove();
    active?.focus({preventScroll: true});
    return true;
  }

  // Copying never changes a draft and never counts as a send.
  async function copyNotes() {
    panels.querySelector('.copybox')?.remove();
    const count = noteCount();
    const shots = notes.filter(note => note.shot).length;
    const references = notes.filter(note => note.ref).length;
    const kept = [shots && plural(shots, 'screenshot'), references && plural(references, 'reference image')].filter(Boolean);
    const images = kept.length ? ' Images are not part of the text: ' + kept.join(' and ')
      + (shots + references === 1 ? ' stays' : ' stay') + ' in Nitpost.' : '';
    const copied = await copyText(notesMarkdown(), 'Chrome blocked copying on this page, so the text of your ' + count);
    message((copied ? 'Copied ' + count + ' as text for any agent.' : 'Not copied yet: the text is selected for you.')
      + ' Your drafts are unchanged.' + images);
    spreadDue = true;
  }

  function copyButton() {
    return control(button('Copy for agent', copyNotes, 'btn secondary', copy), 'copy');
  }

  function section(className, title, ...body) {
    const box = element('section', className);
    box.append(element('p', 'panel-title', title), ...body);
    return box;
  }

  // What the last send from this page confirmed. Only `confirmed` may say the agent accepted it.
  function attemptWords(record) {
    const label = record.target?.label || 'the conversation';
    const batch = plural(record.count ?? record.ids.length, 'note');
    const time = when(record.at).phrase;
    const check = ' Check there first. If they arrived, mark them as received to clear them here.';
    switch (record.status) {
      case 'confirmed':
        return {title: 'Received by ' + label, text: 'The agent accepted ' + batch + ' ' + time + '.'};
      case 'submitted':
        return {title: 'Entered in ' + label, text: 'Nitpost typed ' + batch + ' into the conversation, or started '
          + 'it with them, ' + time + '. The agent sends nothing back, so this does not confirm it read them.'};
      case 'unconfirmed':
        return {title: 'Posted to ' + label + ', no receipt', text: 'Nitpost posted ' + batch + ' to the '
          + 'conversation’s inbox ' + time + '. Nothing confirms the agent picked them up.' + check};
      case 'failed':
        return {title: 'Not sent to ' + label, text: (record.detail || 'The send ' + time + ' did not go through.')
          + ' Your notes are still here.'};
      default:
        return {title: 'No result recorded for ' + label, text: 'Nitpost started sending ' + batch + ' ' + time
          + ' and has no confirmed result, so they may or may not have arrived.' + check};
    }
  }

  // The attempt's own notes that are still drafts on this page.
  function heldNotes() {
    return uncertain(attempt) ? notes.filter(note => attempt.ids.includes(note.id)) : [];
  }

  function attemptSection(resend = null) {
    const words = attemptWords(attempt);
    const state = attempt.status === 'pending' ? 'unknown' : attempt.status;
    const box = section('attempt', words.title, element('p', 'panel-text', words.text));
    box.dataset.status = state;
    box.setAttribute('aria-label', 'Last send from this page');
    const time = element('time', '', when(attempt.at).text);
    time.dateTime = when(attempt.at).iso;
    box.firstChild.append(time);
    if (attempt.detail && state !== 'failed') box.append(element('p', 'panel-detail', attempt.detail));
    const held = heldNotes();
    if (!held.length) return box;
    const added = notes.length - held.length;
    if (added) {
      box.append(element('p', 'panel-detail', plural(added, 'note') + ' added since then '
        + (added === 1 ? 'is' : 'are') + ' not part of it. Send is available again once you have chosen.'));
    }
    // The choice is about the record on screen. If another tab sent again or settled it meanwhile,
    // the background refuses, and the current record is shown with its reason.
    const settle = action => async () => {
      const currentPage = page;
      const result = await exchange('resolve', {action, attempt: attempt.at});
      if (currentPage !== page) return;
      const done = action === 'received' ? 'Marked as received. Those notes are cleared.'
        : 'Kept as drafts. They go out with your next send.';
      await review(result?.ok ? done : '');
      if (currentPage === page && !result?.ok) message(result?.error || 'The request failed. Try again.', true);
    };
    const actions = element('div', 'panel-actions');
    if (resend) actions.append(resend);
    actions.append(control(button('Mark as received', settle('received'), 'btn secondary'), 'received'),
      control(button('Keep as drafts', settle('dismiss'), 'btn secondary'), 'dismiss'));
    box.append(actions);
    return box;
  }

  function fact(name, value, state) {
    const row = element('div', 'fact');
    row.dataset.fact = name.toLowerCase().replace(/\s+/g, '-');
    row.dataset.state = state;
    row.append(element('dt', '', name), element('dd', '', value));
    return row;
  }

  function shortcutTip() {
    const text = shortcut
      ? ['Press ', element('span', 'key shortcut-key', shortcut), ' to open or close Nitpost. '
        + 'A menu that is open stays open, so you can annotate it.']
      : ['No keyboard shortcut is set. Choose one at ', element('code', '', shortcutSettings),
        ' to open Nitpost without closing an open menu.'];
    const tip = element('p', 'panel-text');
    tip.append(...text);
    const box = element('section', 'tip');
    box.append(tip);
    return box;
  }

  // Offered beside the facts it sends. The background builds the report, and this tab adds only
  // the helper state.
  function reportProblem(connection) {
    const open = async () => {
      await request('report', {connection});
      message('Opened a GitHub issue in a new tab. Nothing is sent unless you submit it there.');
    };
    const row = element('p', 'panel-detail report');
    row.append(control(button('Report a problem', open, 'quiet'), 'report'), element('span', '',
      'Opens a GitHub issue with the Nitpost and Chrome versions, the helper state and the result '
      + 'of the last send. Nothing from this page or your notes is included.'));
    return row;
  }

  function panel(...sections) {
    const box = element('div', 'panel');
    box.append(...sections);
    return box;
  }

  function orphanSection() {
    return section('route', 'Nitpost lost its connection to this tab',
      element('p', 'panel-text', 'The extension was reloaded or updated. Your notes are saved in Chrome and are '
        + 'still shown here. Use Copy for agent if you need them now, then reload this tab to reconnect.'));
  }

  function showReview(notice = '', details = false) {
    const currentPage = page;
    draft = null;
    setMode('review');
    const bar = element('div', 'toolbar');
    const add = control(notes.length ? button('Pick element', pick, 'btn secondary', plus)
      : button('Pick an element', pick, 'btn primary', plus), 'pick');
    bar.append(mark());
    if (!notes.length) bar.append(element('p', 'muted', 'No notes on this page yet.'));
    bar.append(add);
    surface.append(bar);
    if (orphaned) {
      bar.dataset.connection = 'orphaned';
      if (notes.length) bar.append(copyButton());
      panels.append(panel(orphanSection()));
    } else if (notes.length) {
      void destination(currentPage, bar, details);
    } else {
      const tip = shortcutTip();
      tip.append(reportProblem('unchecked'));
      panels.append(panel(...(attempt ? [attemptSection()] : []), tip));
    }
    bar.append(dimToggle(), button('Close', () => idle(true), 'icon', close));
    if (notice && !status.textContent) message(notice);
    if (!details) focus(add);
  }

  function option(name, value, disabled = false) {
    const item = element('option', '', name);
    item.value = value;
    item.disabled = disabled;
    return item;
  }

  function field(label, id) {
    const select = element('select');
    select.id = id;
    select.setAttribute('aria-label', label);
    const box = element('div', 'select');
    box.append(select);
    return {select, box};
  }

  function appendGroup(select, label, options) {
    if (!options.length) return;
    const group = element('optgroup');
    group.label = label;
    group.append(...options);
    select.append(group);
  }

  // Whether Chrome reached the helper, with the way forward when it did not.
  function helperFact(found) {
    if (found.connection === 'checking') return fact('Helper', 'Checking…', 'checking');
    if (found.connection === 'connected' || found.connection === 'error') {
      return fact('Helper', 'Connected. Chrome reached the Nitpost helper on this Mac.', 'ok');
    }
    if (found.connection === 'missing') {
      const link = element('a', '', 'Open the install instructions');
      link.href = installGuide;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Opens the Nitpost page on GitHub in a new tab';
      const row = fact('Helper', 'Not installed. Chrome found no Nitpost helper on this Mac, so it cannot send. ',
        'problem');
      row.lastChild.append(link, ', run the installer, then press Check again. Until then, Copy for agent puts your '
        + 'notes on the clipboard to paste into any agent.');
      return row;
    }
    return fact('Helper', 'Not responding. Chrome found the helper but got no answer. Run the installer again, '
      + 'then press Check again. Copy for agent works without it.', 'problem');
  }

  // Whether a conversation can take the notes, and what each route found.
  function conversationFact(found) {
    if (found.connection === 'checking') return fact('Conversations', 'Checking…', 'checking');
    if (found.connection === 'error') {
      return fact('Conversations', 'The helper could not list them. ' + (found.error || 'It gave no reason.')
        + ' Press Check again once that is fixed. Copy for agent works meanwhile.', 'problem');
    }
    if (found.connection !== 'connected') {
      return fact('Conversations', 'Not checked. Finding them needs the helper.', 'unknown');
    }
    const ready = found.available.length;
    const lead = found.gone
      ? found.gone + ' is no longer available. It may have closed or be busy. Your notes are still here. '
        + (ready ? 'Choose another conversation, or reopen it and press Check again.' : 'Reopen it and press Check again.')
      : ready ? plural(ready, 'conversation') + ' ready to receive notes.'
        : 'None is ready to receive notes. Open one, or free one that is busy, then press Check again.';
    const row = fact('Conversations', lead, found.gone || !ready ? 'problem' : 'ok');
    const reasons = found.checks.filter(check => check && typeof check.detail === 'string' && check.detail);
    if (reasons.length) {
      const list = element('ul', 'checks');
      for (const check of reasons) {
        const entry = element('li');
        entry.dataset.route = String(check.route);
        entry.append(element('strong', '', routeNames[check.route] || String(check.route)), ' ' + check.detail);
        list.append(entry);
      }
      row.lastChild.append(list);
    } else if (!ready) {
      row.lastChild.append(' Claude Code needs a session with a peer inbox. Codex needs an idle thread, or a ready '
        + 'pane in Rex or tmux.');
    }
    if (!ready && found.starts.length) {
      row.lastChild.append(element('p', '',
        'Or choose a project, then start a new session in Rex from the Conversation list.'));
    }
    return row;
  }

  // One sentence for a screen reader, which does not see the panel appear.
  function routeSummary(found) {
    if (found.connection === 'missing') return 'The Nitpost helper is not installed. Copy for agent still works.';
    if (found.connection === 'error') return 'The helper could not list conversations. ' + found.error;
    if (found.connection !== 'connected') return 'The Nitpost helper is not responding. Copy for agent still works.';
    if (found.gone) return found.gone + ' is no longer available. Your notes are still here.';
    if (!found.available.length) return 'No conversation is ready to receive notes.';
    return plural(found.available.length, 'conversation') + ' ready to receive notes.';
  }

  // Helper, conversations and last send are three separate facts, each with its own recovery.
  function routeSection(found) {
    const facts = element('dl', 'facts');
    facts.append(helperFact(found), conversationFact(found));
    if (!attempt) facts.append(fact('Last send', 'Nothing has been sent from this page.', 'none'));
    const box = element('section', 'route');
    box.setAttribute('aria-label', 'Helper and conversations');
    box.dataset.connection = found.connection;
    box.dataset.eligible = String(found.available.length);
    if (found.gone) box.dataset.gone = '';
    box.append(facts, reportProblem(found.connection));
    return box;
  }

  async function destination(currentPage, bar, details) {
    const folder = field('Project', 'nitpost-project');
    const conversation = field('Conversation', 'nitpost-target');
    const found = {connection: 'checking', available: [], starts: [], checks: [], gone: '', error: ''};
    let chosen = null;
    let loading = true;
    let saving = false;
    const count = noteCount();
    const held = heldNotes();

    async function submit(ids, again) {
      if (!chosen || !ids.length || saving) return;
      saving = true;
      const starting = !chosen.block;
      updateControls();
      message(starting ? 'Starting ' + agentNames[chosen.agent] + '…' : 'Sending notes…');
      const before = attempt?.at;
      const origin = send.getBoundingClientRect();
      let result = null;
      let stopped = null;
      try {
        result = await exchange('send', {ids, target: chosen, ...(again ? {resend: true, attempt: before} : {})});
      } catch (err) {
        // A worker that stopped mid-send may have left a record. Reload it instead of guessing.
        if (orphaned) throw err;
        stopped = err;
      } finally {
        saving = false;
        if (send.isConnected) updateControls();
      }
      if (currentPage !== page) return;
      await review();
      if (currentPage !== page || !host.isConnected) return;
      // A new record is on screen in the panel. A refusal that made no record gives its reason here.
      const recorded = attempt && attempt.at !== before;
      if (recorded) announce(attemptWords(attempt).title + '. ' + attemptWords(attempt).text);
      if (stopped) {
        message('Chrome stopped Nitpost before the send finished. ' + (recorded
          ? 'What is known about it is shown above.' : 'Nothing was recorded, so send again.'), true);
      } else if (!result?.ok && !(recorded && result?.error === attempt.detail)) {
        message(result?.error || 'The request failed. Try again.', true);
      }
      if (result?.ok && ['confirmed', 'submitted'].includes(attempt?.status)) fly(origin);
    }

    // An uncertain batch blocks the plain Send. Sending it again is a separate, deliberate button.
    const sendAll = () => submit(notes.map(note => note.id), false);
    const send = control(button('Send ' + count, sendAll, 'btn primary', arrow), 'send');
    const sendLabel = send.lastChild;
    const resend = held.length
      ? control(button('Send again', () => submit(held.map(note => note.id), true), 'btn secondary'), 'resend') : null;
    const check = control(button('Check again for conversations', () => review('', true), 'icon', refresh), 'check');
    bar.append(folder.box, conversation.box, check, copyButton(), send);
    if (details) focus(check);

    const attention = () => found.connection !== 'checking'
      && (found.connection !== 'connected' || !found.available.length || Boolean(found.gone));

    function renderPanel() {
      const sections = [];
      if (attempt) sections.push(attemptSection(resend));
      if (details || attention()) sections.push(routeSection(found));
      const copying = panels.querySelector('.copybox');
      panels.replaceChildren(...(sections.length ? [panel(...sections)] : []), ...(copying ? [copying] : []));
      bar.dataset.connection = found.connection;
      spreadDue = true;
    }

    function renderProjects() {
      const active = [...new Set(found.available.map(item => item.project).filter(Boolean))];
      const recent = [...new Set([project, ...recentProjects])].filter(p => p && !active.includes(p));
      const paths = [...active, ...recent];
      const basename = value => value.split('/').filter(Boolean).pop() || '/';
      const projectOption = value => {
        const name = basename(value);
        const duplicate = paths.some(other => other !== value && basename(other) === name);
        return option(duplicate ? value : name, value);
      };
      folder.select.replaceChildren(option(loading ? 'Checking for conversations…' : 'Choose a project', '', true));
      appendGroup(folder.select, 'Active conversations', active.map(projectOption));
      appendGroup(folder.select, 'Recent folders', recent.map(projectOption));
      folder.select.append(option('Choose folder…', 'browse'));
      folder.select.value = project || '';
      folder.select.title = project || '';
    }

    function renderConversations() {
      chosen = null;
      conversation.select.replaceChildren(option(project ? 'Choose a conversation' : 'Choose a project first', '', true));
      if (project) {
        const matches = found.available.filter(item => item.project === project);
        appendGroup(conversation.select, 'Open conversations', matches.map(item => option(item.label, item.block)));
        appendGroup(conversation.select, 'Start a new session in Rex', Object.entries(agentNames)
          .filter(([id]) => found.starts.includes(id)).map(([id, name]) => option('New ' + name + ' session', id)));
        chosen = matches.find(item => item.block === target?.block && item.session === target?.session
          && (!target.identity || item.identity === target.identity))
          || (target?.project === project && !target.block && found.starts.includes(target.agent) ? target : null);
      }
      conversation.select.value = chosen?.block || chosen?.agent || '';
      updateControls();
    }

    function updateControls() {
      const offline = ['missing', 'unreachable'].includes(found.connection);
      folder.box.hidden = offline;
      conversation.box.hidden = offline;
      folder.select.disabled = loading || saving;
      conversation.select.disabled = loading || saving || !project;
      send.disabled = loading || saving || !chosen || held.length > 0;
      send.title = held.length ? 'Decide what happened to the earlier batch first.' : '';
      if (resend) {
        resend.disabled = loading || saving || !chosen;
        resend.title = chosen || loading ? '' : 'Choose a conversation to send to first.';
      }
      check.disabled = saving;
      check.toggleAttribute('data-busy', loading);
      sendLabel.data = (chosen && !chosen.block ? 'Start & send ' : 'Send ') + count;
      send.toggleAttribute('data-busy', saving);
    }

    async function saveChoice(nextProject, nextTarget) {
      await request('select', {project: nextProject, target: nextTarget});
      if (!send.isConnected || currentPage !== page) return;
      project = nextProject;
      target = nextTarget;
      recentProjects = [project, ...recentProjects.filter(p => p !== project)];
      found.gone = '';
      message();
      renderPanel();
    }

    function onChange(select, change) {
      select.addEventListener('change', event => {
        if (!event.isTrusted) return;
        void run(async () => {
          saving = true;
          updateControls();
          try {
            await change();
          } finally {
            saving = false;
            if (send.isConnected) {
              renderProjects();
              renderConversations();
            }
          }
        });
      });
    }

    onChange(folder.select, async () => {
      let next = folder.select.value;
      if (next === 'browse') next = (await request('chooseFolder')).project;
      if (next && next !== project && send.isConnected) await saveChoice(next, null);
    });
    onChange(conversation.select, async () => {
      const id = conversation.select.value;
      const next = Object.hasOwn(agentNames, id) ? {project, agent: id}
        : found.available.find(item => item.project === project && item.block === id);
      if (next) await saveChoice(project, next);
    });

    // The saved conversation counts as gone when the helper answered and no longer lists it.
    function resolveSaved() {
      if (!project && !target && found.available.length === 1) {
        target = found.available[0];
        project = target.project;
      }
      // Older versions remembered the pane IDs alone. Resolve its current folder by both IDs.
      if (!project && target?.block) {
        project = found.available.find(item => item.block === target.block && item.session === target.session)?.project || null;
      }
      const listed = target?.block && found.available.some(item => item.project === project
        && item.block === target.block && item.session === target.session
        && (!target.identity || target.identity === item.identity));
      if (target?.block && !listed) found.gone = target.label || 'The saved conversation';
    }

    renderProjects();
    renderConversations();
    renderPanel();
    try {
      const result = await request('targets');
      if (!send.isConnected || currentPage !== page) return;
      found.connection = ['missing', 'unreachable', 'error'].includes(result.connection) ? result.connection : 'connected';
      found.error = typeof result.error === 'string' ? result.error : '';
      found.available = (result.targets ?? []).filter(item => !['Terminal', 'iTerm2', 'codex-queue'].includes(item.session));
      found.starts = result.starts ?? [];
      found.checks = Array.isArray(result.checks) ? result.checks : [];
      if (found.connection === 'connected') resolveSaved();
    } catch (err) {
      if (!send.isConnected) return;
      if (orphaned) {
        showReview();
        return;
      }
      found.connection = 'unreachable';
      message(err.message, true);
    }
    loading = false;
    renderProjects();
    renderConversations();
    renderPanel();
    if (details) announce('Checked again. ' + routeSummary(found));
    else if (attention() && !spoken.textContent) announce(routeSummary(found));
  }

  function fly(origin) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const parcel = mark();
    parcel.classList.add('parcel');
    parcel.style.left = origin.left + origin.width / 2 + 'px';
    parcel.style.top = origin.top + origin.height / 2 + 'px';
    parcel.addEventListener('animationend', () => parcel.remove());
    shadow.append(parcel);
  }

  window.addEventListener('focusin', event => {
    if (mode === 'pick') highlight(event.target);
  }, true);

  function widen(key) {
    if (key === 'ArrowDown') {
      if (descent.length) highlight(descent.pop(), true);
      return;
    }
    const parent = parentOf(marked);
    if (!parent || parent === rootOf(document)) return;
    descent.push(marked);
    highlight(parent, true);
  }

  // Enter takes the marked element the way a click does in the current mode.
  function pickEnter(event) {
    const node = areaOf(marked) ? null : marked ?? event.target;
    const command = event.metaKey || event.ctrlKey;
    if (pickMode === 'group' && command) {
      void run(finishGroup);
    } else if (command) {
      return false;
    } else if (pickMode === 'area') {
      if (node instanceof Element) chooseArea(boxOf(node));
    } else if (pickMode === 'group' || event.shiftKey) {
      toggleGroup(node);
    } else {
      choose(node);
    }
    return true;
  }

  function typingInto(node) {
    return node instanceof Element
      && Boolean(closestTo(node, 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
  }

  // One key reaches the three modes, so nobody has to tab through the whole page to the picker bar.
  function cycleMode() {
    const order = ['element', 'group', 'area'];
    setPickMode(order[(order.indexOf(pickMode) + 1) % order.length]);
  }

  // While picking, Enter takes the marked element and the arrows walk up and back down from it.
  function pickKey(event) {
    if (mode !== 'pick' || event.target === host) return false;
    if (event.key === 'Enter') return pickEnter(event);
    const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey;
    if (plain && event.key.toLowerCase() === modeKey && !typingInto(event.target)) {
      cycleMode();
      return true;
    }
    const arrow = ['ArrowUp', 'ArrowDown'].includes(event.key) && !event.metaKey && !event.ctrlKey;
    if (!arrow || !marked || areaOf(marked)) return false;
    widen(event.key);
    return true;
  }

  function escapeKey(event) {
    if (mode === 'idle' || event.key !== 'Escape' || event.metaKey || event.ctrlKey) return false;
    if (mode !== 'pick' && event.target !== host) return false;
    if (mode === 'pick' && corner) {
      corner = null;
      highlight(null);
      renderPickBar();
    } else if (mode === 'review') {
      idle(true);
    } else {
      void run(back);
    }
    return true;
  }

  window.addEventListener('keydown', event => {
    // A new press means the release of the last handled one is over or was never delivered here.
    handledKey = null;
    if (!event.isTrusted || busy || event.altKey || !host.isConnected) return;
    if (!pickKey(event) && !escapeKey(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handledKey = event.key;
  }, true);

  // The page must not see the release of a key press that Nitpost handled.
  window.addEventListener('keyup', event => {
    if (event.key !== handledKey) return;
    handledKey = null;
    event.stopImmediatePropagation();
  }, true);
  // A key released while another window had focus never arrives. Do not wait for it.
  window.addEventListener('blur', () => {
    handledKey = null;
  });

  function routeChanged() {
    if (location.href === page) return false;
    page = location.href;
    busy = false;
    surface.removeAttribute('aria-busy');
    notes = [];
    target = null;
    project = null;
    attempt = null;
    renderPins();
    idle();

    return true;
  }
  window.navigation?.addEventListener('currententrychange', routeChanged);
  window.addEventListener('pageshow', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  window.addEventListener('popstate', routeChanged);
  globalThis.toggleNitpost = toggle;
  await toggle();
})();
