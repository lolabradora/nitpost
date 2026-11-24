// The page owns the document. Keep controls, note text and their event handlers in a closed shadow tree.
(async () => {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const stylesheet = new CSSStyleSheet();
  const css = await fetch(chrome.runtime.getURL('overlay.css'));
  if (!css.ok) return;
  stylesheet.replaceSync(await css.text());
  shadow.adoptedStyleSheets = [stylesheet];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  }
  const pen = 'm4 17-.8 4 4-.9 12-12-3.2-3.2z M14.5 6.4l3.2 3.2';
  const close = 'm6 6 12 12 M18 6 6 18';
  const refresh = 'M20 5v5h-5 M19 10a7.5 7.5 0 1 0 .2 5';

  const shield = element('div', 'shield');
  const outline = element('div', 'outline');
  const dock = element('div', 'dock');
  dock.lang = 'en';
  const surface = element('div');
  const status = element('p', 'status');
  for (const type of ['keydown', 'keyup', 'keypress']) {
    dock.addEventListener(type, event => event.stopPropagation());
  }
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  dock.append(surface, status);
  shadow.append(shield, outline, dock);
  document.documentElement.append(host);

  let page = location.href;
  let mode = 'idle';
  let notes = [];
  let target = null;
  let project = null;
  let recentProjects = [];
  let draft = null;
  let busy = false;
  let previousFocus = null;

  function message(value = '', error = false) {
    status.textContent = value;
    status.classList.toggle('error', error);
  }

  async function request(op, params = {}) {
    if (location.href !== page) throw new Error('The page changed. Reopen PaneParcel here.');
    let result;
    try {
      result = await chrome.runtime.sendMessage({ op, page, ...params });
    } catch {
      throw new Error('PaneParcel disconnected. Reload this tab to reconnect.');
    }
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
      if (currentPage === page) message(err.message, true);
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
      b.append(document.createTextNode(label));
    }
    b.addEventListener('click', event => {
      if (event.isTrusted) void run(onClick);
    });
    return b;
  }

  function focus(node) {
    queueMicrotask(() => node.isConnected && node.focus({ preventScroll: true }));
  }

  function setMode(next) {
    mode = next;
    const picking = next === 'pick';
    shield.hidden = !picking;
    outline.hidden = true;
    dock.classList.toggle('panel', next === 'edit' || next === 'review');
    surface.replaceChildren();
    message();
  }

  function refreshLauncher() {
    const launcher = surface.querySelector('.launch');
    if (!launcher) return;
    launcher.replaceChildren(icon(pen), notes.length ? 'Page notes' : 'Annotate');
    if (notes.length) launcher.append(element('span', 'count', String(notes.length)));
  }

  function idle(restore = false) {
    draft = null;
    setMode('idle');
    const launcher = button('Annotate', async () => {
      const currentPage = page;
      await loadState();
      if (page !== currentPage) return;
      if (notes.length) await review();
      else pick();
    }, 'launch');
    surface.append(launcher);
    refreshLauncher();
    if (restore) focus(launcher);
  }

  function pick() {
    previousFocus = document.activeElement === host ? null : document.activeElement;
    setMode('pick');
    const bar = element('div', 'pickbar');
    const cancel = button('Cancel', () => notes.length ? review() : idle(true));
    bar.append(icon(pen), element('span', '', 'Pick an element'), cancel);
    surface.append(bar);
    if (previousFocus instanceof HTMLElement) previousFocus.focus({preventScroll: true});
    else document.activeElement?.blur();
  }

  function underPointer(event) {
    shield.style.pointerEvents = 'none';
    const node = document.elementFromPoint(event.clientX, event.clientY);
    shield.style.pointerEvents = '';
    return node === host ? null : node;
  }

  function highlight(node) {
    if (!node || node === host || node === document.documentElement) {
      outline.hidden = true;
      return;
    }
    const rect = node.getBoundingClientRect();
    Object.assign(outline.style, {
      left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', height: rect.height + 'px',
    });
    outline.hidden = false;
  }

  // Use unique IDs where available. Otherwise retain the structural path to the element.
  function selectorFor(node) {
    const parts = [];
    for (let el = node; el; el = el.parentElement) {
      if (el.id) {
        const id = '#' + CSS.escape(el.id);
        if (document.querySelectorAll(id).length === 1) {
          parts.unshift(id);
          break;
        }
      }
      let part = CSS.escape(el.localName);
      if (el.parentElement) {
        const sameTag = [...el.parentElement.children].filter(sibling => sibling.localName === el.localName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function choose(node) {
    if (routeChanged() || !(node instanceof Element) || node === host) return;
    const selector = selectorFor(node);
    if (selector.length > 2048) {
      message('This element has a long selector. Pick its parent instead.', true);
      return;
    }
    const editable = node.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    // Collect a short excerpt, skipping editable descendants and their values.
    let excerpt = node.getAttribute('aria-label') || node.getAttribute('alt') || '';
    if (!editable && !excerpt) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(child) {
          if (child.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          if (child.matches('input, textarea, select, [contenteditable], script, style, template, [hidden]')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      });
      let part;
      let visited = 0;
      while (excerpt.length < 180 && visited++ < 500 && (part = walker.nextNode())) {
        excerpt += ' ' + part.textContent.trim().slice(0, 180);
      }
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    edit({id, selector, text: excerpt.trim().replace(/\s+/g, ' ').slice(0, 180),
      width: window.innerWidth, height: window.innerHeight, comment: ''}, false);
  }

  shield.addEventListener('pointermove', event => highlight(underPointer(event)));
  shield.addEventListener('pointerleave', () => { outline.hidden = true; });
  shield.addEventListener('click', event => {
    if (event.isTrusted && mode === 'pick') choose(underPointer(event));
  });

  function header(title, onClose) {
    const row = element('header');
    row.append(element('h2', '', title), button('Close', onClose, 'icon', close));
    return row;
  }

  function edit(note, existing) {
    setMode('edit');
    draft = {...note};
    const context = element('code', '', note.selector);
    context.title = note.selector;
    const label = element('label', '', 'Comment');
    label.htmlFor = 'paneparcel-comment';
    const input = element('textarea');
    input.id = label.htmlFor;
    input.placeholder = 'What should change?';
    input.maxLength = 2000;
    input.value = draft.comment;
    const saveNote = async () => {
      const currentPage = page;
      const comment = input.value.trim();
      if (!comment) return;
      if (existing) await request('edit', {id: draft.id, comment});
      else await request('add', {note: {...draft, comment}});
      if (page === currentPage) await review();
    };
    const save = button('Save note', saveNote, 'primary');
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
    const cancel = () => notes.length ? review() : idle(true);
    const actions = element('div', 'actions');
    actions.append(button('Cancel', cancel), save);
    surface.append(header(existing ? 'Edit note' : 'New note', cancel), context);
    if (note.text) surface.append(element('p', 'excerpt', note.text));
    surface.append(label, input, actions);
    focus(input);
  }

  async function review(notice = '') {
    const currentPage = page;
    await loadState();
    if (currentPage !== page) return;
    draft = null;
    setMode('review');
    const add = button('Pick another element', pick, 'add');
    surface.append(header('Page notes', () => idle(true)));
    if (notes.length) {
      const list = element('ol', 'list');
      for (const note of notes) {
        const item = element('li');
        const selector = element('code', '', note.selector);
        selector.title = note.selector;
        const actions = element('div', 'item-actions');
        actions.append(button('Edit', () => edit(note, true)), button('Remove', async () => {
          const originalPage = page;
          await request('remove', {id: note.id});
          if (originalPage === page) await review();
        }));
        item.append(selector, element('p', 'comment', note.comment), actions);
        list.append(item);
      }
      surface.append(list);
    } else {
      add.textContent = 'Pick an element';
      surface.append(element('p', 'muted', 'Select an element on this page to add a note.'));
    }
    surface.append(add);
    if (notes.length) void destination(currentPage);
    if (notice && !status.textContent) message(notice);
    focus(add);
  }

  function option(name, value, disabled = false) {
    const item = element('option', '', name);
    item.value = value;
    item.disabled = disabled;
    return item;
  }

  function field(label, id) {
    const caption = element('label', '', label);
    caption.htmlFor = id;
    const select = element('select');
    select.id = id;
    return {caption, select};
  }

  function appendGroup(select, label, options) {
    if (!options.length) return;
    const group = element('optgroup');
    group.label = label;
    group.append(...options);
    select.append(group);
  }

  async function destination(currentPage) {
    const folder = field('Project', 'paneparcel-project');
    const conversation = field('Conversation', 'paneparcel-target');
    const path = element('p', 'project-path');
    path.id = 'paneparcel-path';
    folder.select.setAttribute('aria-describedby', path.id);
    const row = element('div', 'destination');
    row.append(folder.select, button('Refresh projects and conversations', () => review(), 'icon', refresh));
    let available = [];
    let chosen = null;
    let loading = true;
    let saving = false;
    const agentNames = {codex: 'Codex', claude: 'Claude Code'};
    const count = notes.length + (notes.length === 1 ? ' note' : ' notes');
    async function submit(focusRex) {
      if (!chosen || send.disabled) return;
      saving = true;
      const starting = !chosen.block;
      updateControls();
      message(starting ? 'Starting ' + agentNames[chosen.agent] + '…' : 'Sending notes…');
      try {
        const result = await request('send', {ids: notes.map(note => note.id), target: chosen, focus: focusRex});
        if (currentPage === page) {
          const notice = 'Sent to ' + result.target.label + '.';
          await review(result.focusFailed ? notice + ' Open this pane manually in Rex.' : notice);
        }
      } finally {
        saving = false;
        if (send.isConnected) updateControls();
      }
    }
    const send = button('Send in background', () => submit(false), 'primary');
    const reveal = button('Send + focus Rex', () => submit(true));
    const delivery = element('div', 'delivery');
    delivery.append(send, reveal);
    surface.append(folder.caption, row, path, conversation.caption, conversation.select, delivery);

    function renderProjects() {
      const active = [...new Set(available.map(item => item.project).filter(Boolean))];
      const recent = [...new Set([project, ...recentProjects])].filter(p => p && !active.includes(p));
      const paths = [...active, ...recent];
      const basename = value => value.split('/').filter(Boolean).pop() || '/';
      const projectOption = value => {
        const name = basename(value);
        const duplicate = paths.some(other => other !== value && basename(other) === name);
        return option(duplicate ? value : name, value);
      };
      folder.select.replaceChildren(option(loading ? 'Loading projects…' : 'Choose a project', '', true));
      appendGroup(folder.select, 'Active in Rex', active.map(projectOption));
      appendGroup(folder.select, 'Recent folders', recent.map(projectOption));
      folder.select.append(option('Choose folder…', 'browse'));
      folder.select.value = project || '';
      path.textContent = project || '';
    }

    function renderConversations() {
      chosen = null;
      conversation.select.replaceChildren(option(project ? 'Choose a conversation' : 'Choose a project first', '', true));
      if (project) {
        const matches = available.filter(item => item.project === project);
        appendGroup(conversation.select, 'Running in Rex', matches.map(item => option(item.label, item.block)));
        appendGroup(conversation.select, 'Start in this folder', Object.entries(agentNames)
          .map(([id, name]) => option('New ' + name + ' session', id)));
        chosen = matches.find(item => item.block === target?.block && item.session === target?.session)
          || (target?.project === project && !target.block && Object.hasOwn(agentNames, target.agent) ? target : null);
      }
      conversation.select.value = chosen?.block || chosen?.agent || '';
      updateControls();
    }

    function updateControls() {
      folder.select.disabled = loading || saving;
      conversation.select.disabled = loading || saving || !project;
      send.disabled = loading || saving || !chosen;
      reveal.disabled = send.disabled;
      const action = chosen && !chosen.block ? 'Start & send' : 'Send';
      send.textContent = action + ' in background';
      reveal.textContent = chosen && !chosen.block ? 'Start, send & focus Rex' : 'Send + focus Rex';
      send.title = action + ' ' + count + ' and stay in Chrome';
      reveal.title = action + ' ' + count + ' and open the destination in Rex';
    }

    async function saveChoice(nextProject, nextTarget) {
      await request('select', {project: nextProject, target: nextTarget});
      if (!send.isConnected || currentPage !== page) return;
      project = nextProject;
      target = nextTarget;
      recentProjects = [project, ...recentProjects.filter(p => p !== project)];
      message();
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
        : available.find(item => item.project === project && item.block === id);
      if (next) await saveChoice(project, next);
    });

    renderProjects();
    renderConversations();
    try {
      const result = await request('targets');
      if (!send.isConnected || currentPage !== page) return;
      available = result.targets;
      // Older versions remembered the pane IDs alone. Resolve its current folder by both IDs.
      if (!project && target?.block) {
        project = available.find(item => item.block === target.block && item.session === target.session)?.project || null;
      }
      if (target?.block && !available.some(item => item.project === project
          && item.block === target.block && item.session === target.session)) {
        message('The saved conversation is unavailable. Choose another conversation or start a session.');
      }
    } catch (err) {
      if (send.isConnected) message(err.message, true);
    } finally {
      if (send.isConnected) {
        loading = false;
        renderProjects();
        renderConversations();
      }
    }
  }

  window.addEventListener('scroll', () => {
    if (mode === 'pick') outline.hidden = true;
  }, true);
  window.addEventListener('focusin', event => {
    if (mode === 'pick') highlight(event.target);
  }, true);
  window.addEventListener('keydown', event => {
    if (!event.isTrusted || busy) return;
    if (mode === 'pick' && event.key === 'Enter' && event.target !== host) {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(event.target);
    } else if (mode !== 'idle' && event.key === 'Escape' && (mode === 'pick' || event.target === host)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode === 'edit' && notes.length) void run(() => review());
      else idle(true);
    }
  }, true);

  function routeChanged() {
    if (location.href === page) return false;
    page = location.href;
    busy = false;
    surface.removeAttribute('aria-busy');
    notes = [];
    target = null;
    project = null;
    idle();
    void loadState().then(refreshLauncher).catch(() => {});
    return true;
  }
  window.navigation?.addEventListener('currententrychange', routeChanged);
  window.addEventListener('pageshow', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  window.addEventListener('popstate', routeChanged);
  idle();
  await loadState().then(refreshLauncher).catch(() => {});
})();
