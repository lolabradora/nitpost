(() => {
  const demo = document.getElementById('demo');
  if (!demo) return;

  const projects = [
    { name: 'forma-studio', path: '~/Projects/forma-studio', conversations: [
      { name: 'Codex · Object page · 8f32ac', route: 'Idle shared local thread' },
      { name: 'Claude Code · Collection layout · b37ea2', route: 'Live Claude peer inbox' }
    ] },
    { name: 'forma-catalog', path: '~/Projects/forma-catalog', conversations: [
      { name: 'Codex · Catalog layout · tab 2 / pane 1', route: 'Ready Rex pane' },
      { name: 'Codex · Material index · 1d49bc', route: 'Ready tmux pane' }
    ] }
  ];
  const tour = {
    target: 'fold-title',
    comment: 'Make this title larger.',
    project: 'forma-studio',
    conversation: 'Codex · Object page · 8f32ac'
  };
  const guidePage = {
    url: 'https://forma.guide/materials/resin',
    title: 'Resin care',
    description: 'Dust cast resin with a soft cloth. Keep the surface dry.',
    comment: 'Specify a soft, dry microfiber cloth.'
  };
  const STOPPED = Symbol('stopped');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const icon = '<img src="toolbar-icon.png" alt="" width="22" height="22">';

  demo.innerHTML = `
    <div class="fd-scene" role="img" aria-label="Animated walkthrough: a title is picked on a sample page, a note is written and sent, and a simulated agent terminal receives it.">
      <div class="fd-window">
        <div class="fd-chrome">
          <span class="fd-lights" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="fd-address" aria-label="Sample page URL">https://forma.studio/objects/fold</span>
          <button class="fd-toolbar" type="button" aria-label="Open Nitpost toolbar icon" aria-pressed="false"><span>Start here</span><img src="toolbar-icon.png" width="26" height="26" alt=""></button>
        </div>
        <div class="fd-store">
          <div class="fd-mast"><span class="fd-brand"><i aria-hidden="true"></i>Forma</span><span>Object collection</span></div>
          <div class="fd-spread">
            <button type="button" class="fd-target fd-art" data-target="fold-image" aria-label="Select sculpture image" disabled>
              <img id="fold-image" src="forma-fold.webp" width="960" height="580" alt="Lilac Fold Study sculpture">
            </button>
            <div class="fd-info">
              <div class="fd-catalog">Sculpture <span>/</span> F–001</div>
              <h3 class="fd-title"><button type="button" class="fd-target" data-target="fold-title" aria-label="Select object title" disabled><span id="fold-title">Fold Study</span></button></h3>
              <div class="fd-description"><button type="button" class="fd-target" data-target="fold-description" aria-label="Select object description" disabled><span id="fold-description">A continuous loop of fine lilac ribs, turning light into alternating bands of color and shadow.</span></button></div>
            </div>
          </div>
          <dl class="fd-specs">
            <div><dt>Finish</dt><dd>Lilac</dd></div>
            <div><dt>Material</dt><dd>Cast resin</dd></div>
            <div><dt>Edition</dt><dd>40 pieces</dd></div>
          </dl>
          <p class="fd-more"><span>Also in the collection</span><span>Arc Study</span><span>Knot Study</span><span>Wave Study</span></p>
        </div>
        <div class="fd-pickbar" hidden>${icon}<strong>Click an element to annotate</strong><span>Esc to exit</span></div>
        <div class="fd-panel" hidden></div>
      </div>
      <div class="fd-term" role="group" aria-label="Simulated agent terminal">
        <div class="fd-term-head"><span class="fd-term-tab"><i aria-hidden="true"></i><span class="fd-term-name"></span></span><span class="fd-term-route">Simulated</span></div>
        <div class="fd-term-body"><div class="fd-term-log"></div><div class="fd-prompt" aria-hidden="true">›<i class="fd-caret"></i></div></div>
      </div>
      <span class="fd-cursor" aria-hidden="true" hidden><svg viewBox="0 0 22 26"><path d="M2 2v19l5.2-4.6 3.4 7.6 3.3-1.5-3.4-7.5H18z"/></svg></span>
      <span class="fd-parcel" aria-hidden="true" hidden><img src="icon-128.png" alt=""></span>
    </div>`;

  const scene = demo.querySelector('.fd-scene');
  const browser = demo.querySelector('.fd-window');
  const store = demo.querySelector('.fd-store');
  const panel = demo.querySelector('.fd-panel');
  const pickbar = demo.querySelector('.fd-pickbar');
  const terminal = demo.querySelector('.fd-term');
  const terminalBody = demo.querySelector('.fd-term-body');
  const terminalLog = demo.querySelector('.fd-term-log');
  const terminalName = demo.querySelector('.fd-term-name');
  const cursor = demo.querySelector('.fd-cursor');
  const parcel = demo.querySelector('.fd-parcel');
  const toolbar = demo.querySelector('.fd-toolbar');
  let targets = [...store.querySelectorAll('[data-target]')];
  const address = demo.querySelector('.fd-address');
  const shopURL = address.textContent;
  const shopMarkup = store.innerHTML;
  let playing = false;
  let run = 0;
  let note;
  let selectedElement;
  let page;
  let project;
  let conversation;

  function setStage(next) {
    demo.dataset.stage = next;
    const docked = next !== 'idle' && next !== 'pick';
    panel.hidden = !docked;
    pickbar.hidden = next !== 'pick';
    toolbar.setAttribute('aria-pressed', String(next !== 'idle'));
    toolbar.querySelector('span').textContent = next === 'idle' ? 'Start here' : 'Nitpost';
    for (const target of targets) {
      target.disabled = next !== 'pick';
      target.classList.remove('fd-hover');
      target.classList.toggle('fd-chosen', docked && target.contains(selectedElement));
    }
    requestAnimationFrame(keepChosenVisible);
  }

  // The dock floats over the page, like the extension. Scroll the sample page so the pick stays in view.
  function keepChosenVisible() {
    const chosen = store.querySelector('.fd-chosen');
    if (!chosen || panel.hidden) {
      store.style.transform = '';
      return;
    }
    const shift = new DOMMatrix(getComputedStyle(store).transform).m42;
    const dockTop = browser.getBoundingClientRect().top + panel.offsetTop;
    const overlap = chosen.getBoundingClientRect().bottom - shift + 20 - dockTop;
    store.style.transform = overlap > 0 ? 'translateY(' + -Math.round(overlap) + 'px)' : '';
  }

  function showSite(isGuide) {
    // Reuse the sample browser chrome and keep each site's selectable nodes in its own document view.
    store.innerHTML = shopMarkup;
    address.textContent = isGuide ? guidePage.url : shopURL;
    if (isGuide) {
      store.querySelector('.fd-brand').textContent = 'Forma Field Guide';
      store.querySelector('.fd-mast > span:last-child').textContent = 'Materials';
      store.querySelector('.fd-catalog').textContent = 'Care guide / Resin';
      store.querySelector('#fold-title').textContent = guidePage.title;
      store.querySelector('#fold-description').textContent = guidePage.description;
      store.querySelector('.fd-specs').remove();
      store.querySelector('.fd-more').remove();
      for (const target of store.querySelectorAll('[data-target]')) {
        const id = target.dataset.target.replace('fold-', 'care-');
        target.dataset.target = id;
        target.firstElementChild.id = id;
      }
      store.querySelector('[data-target="care-title"]').ariaLabel = 'Select guide title';
      store.querySelector('[data-target="care-description"]').ariaLabel = 'Select care instruction';
    }
    targets = [...store.querySelectorAll('[data-target]')];
    store.classList.remove('fd-applied');
  }

  function visitGuide() {
    note = null;
    selectedElement = null;
    showSite(true);
    setStage('idle');
  }

  function clearSession() {
    run += 1;
    note = null;
    selectedElement = null;
    page = null;
    project = null;
    conversation = null;
    panel.replaceChildren();
    store.classList.remove('fd-applied');
    parcel.hidden = true;
    showSite(false);
    terminalName.textContent = 'Sample conversation';
    terminalLog.innerHTML = '<p class="fd-dim">Idle. Notes sent from Chrome arrive here.</p>';
    setStage('idle');
  }

  function pick() {
    setStage('pick');
  }

  function choose(element) {
    selectedElement = element;
    const viewport = browser.getBoundingClientRect();
    page = demo.querySelector('.fd-address').textContent;
    note = {
      comment: '',
      selector: '#' + CSS.escape(element.id),
      text: (element.getAttribute('alt') || element.textContent).trim().replace(/\s+/g, ' ').slice(0, 180),
      viewport: Math.round(viewport.width) + 'x' + Math.round(viewport.height)
    };
    edit();
  }

  function edit() {
    setStage('edit');
    panel.innerHTML = `<form class="fd-edit"><div class="fd-panel-title">${icon}<h4>New note</h4><code></code></div>
      <div class="fd-note-row"><label for="fd-comment">Comment</label><textarea id="fd-comment" rows="2" maxlength="2000" placeholder="What should change?" required></textarea></div>
      <div class="fd-actions"><button type="button" class="fd-secondary">Pick a different element</button><button type="submit" class="fd-primary" disabled>Save note</button></div></form>`;
    panel.querySelector('code').textContent = note.selector;
    const input = panel.querySelector('textarea');
    const form = input.form;
    const save = panel.querySelector('[type="submit"]');
    input.value = note.comment;
    save.disabled = !input.value.trim();
    input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!input.value.trim()) return;
      note.comment = input.value.trim();
      review();
    });
  }

  function review() {
    setStage('review');
    panel.innerHTML = `<div class="fd-panel-title">${icon}<h4>Page notes</h4><button type="button" class="fd-link">Edit note</button></div>
      <div class="fd-note-preview"><code></code><p></p></div>
      <div class="fd-review"><div class="fd-fields"><label>Project<select id="fd-project" aria-describedby="fd-path"><option value="" disabled>Choose a project</option></select><small id="fd-path"></small></label>
      <label>Conversation<select id="fd-conversation" aria-describedby="fd-route"></select><small id="fd-route"></small></label></div>
      <div class="fd-actions"><button class="fd-primary" type="button">Send</button></div></div>`;
    panel.querySelector('code').textContent = note.selector;
    panel.querySelector('.fd-note-preview p').textContent = note.comment;
    const folders = panel.querySelector('#fd-project');
    const conversations = panel.querySelector('#fd-conversation');
    const send = panel.querySelector('.fd-primary');
    for (const item of projects) folders.add(new Option(item.name, item.name));
    folders.value = project?.name || '';

    function updateActions() {
      send.disabled = !conversation;
      panel.querySelector('#fd-route').textContent = conversation?.route || '';
    }
    function updateConversations() {
      conversations.replaceChildren(new Option(project ? 'Choose a conversation' : 'Choose a project first', ''));
      conversations.options[0].disabled = true;
      conversations.disabled = !project;
      for (const item of project?.conversations || []) conversations.add(new Option(item.name, item.name));
      conversations.value = conversation?.name || '';
      panel.querySelector('#fd-path').textContent = project?.path || '';
      updateActions();
    }
    folders.onchange = () => {
      project = projects.find(item => item.name === folders.value);
      conversation = null;
      updateConversations();
    };
    conversations.onchange = () => {
      conversation = project.conversations.find(item => item.name === conversations.value);
      updateActions();
    };
    updateConversations();
  }

  function pause(ms, token) {
    return new Promise((resolve, reject) => {
      setTimeout(() => token === run ? resolve() : reject(STOPPED), reduceMotion.matches ? 0 : ms);
    });
  }

  function centerOf(node) {
    const frame = scene.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - frame.left, y: rect.top + rect.height / 2 - frame.top };
  }

  async function fly(from, token) {
    if (reduceMotion.matches) return;
    const to = { x: centerOf(terminal).x, y: centerOf(terminal.firstElementChild).y + 50 };
    const peak = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 70 };
    const at = (point, extra) => `translate(${point.x}px, ${point.y}px) ${extra}`;
    parcel.hidden = false;
    const flight = parcel.animate([
      { transform: at(from, 'scale(.3)'), opacity: 0 },
      { transform: at({ x: from.x, y: from.y - 16 }, 'scale(1)'), opacity: 1, offset: .16 },
      { transform: at(peak, 'scale(1.2) rotate(-10deg)'), opacity: 1, offset: .58 },
      { transform: at(to, 'scale(.45) rotate(6deg)'), opacity: 0 }
    ], { duration: 950, easing: 'cubic-bezier(.45, 0, .25, 1)' });
    await flight.finished.catch(() => {});
    parcel.hidden = true;
    if (token !== run) throw STOPPED;
    terminal.classList.remove('fd-received');
    void terminal.offsetWidth;
    terminal.classList.add('fd-received');
  }

  function print(text, style) {
    const line = document.createElement('p');
    line.className = style;
    line.textContent = text;
    terminalLog.append(line);
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  async function agentReplies(token) {
    await pause(900, token);
    if (page === guidePage.url) {
      print('Read the care instruction on forma.guide.', 'fd-step');
      return;
    }
    print('Read ' + note.selector + ' on /objects/fold', 'fd-step');
    await pause(900, token);
    print('Edit fold.css: font-size 3rem → 3.75rem', 'fd-step');
    store.classList.add('fd-applied');
    await pause(900, token);
    keepChosenVisible();
    print('Done. The title is larger.', 'fd-done');
  }

  async function deliver(button) {
    const token = run;
    const from = centerOf(button);
    const peer = conversation.route === 'Live Claude peer inbox';
    const outcome = peer
      ? 'Submitted to the peer inbox. Keep the saved note until you verify delivery.'
      : 'Submitted to the selected conversation.';
    const destination = project.name + ' / ' + conversation.name;
    setStage('sent');
    panel.innerHTML = `<div class="fd-panel-title">${icon}<h4 tabindex="-1">Note submitted</h4></div><p class="fd-outcome"></p>`;
    panel.querySelector('.fd-outcome').textContent = outcome + ' You stay in Chrome.';
    const payload = JSON.stringify({
      'Source page': page,
      notes: [{'User note': note.comment, kind: 'change', 'Selected element': {
        selector: note.selector, text: note.text, viewport: note.viewport
      }}]
    })
      .replace(/['!\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    try {
      await fly(from, token);
      if (terminalName.textContent !== destination) terminalLog.replaceChildren();
      terminalName.textContent = destination;
      print("Web annotations from Nitpost: '" + payload + "'", 'fd-msg');
      await agentReplies(token);
    } catch (error) {
      if (error !== STOPPED) throw error;
    }
  }

  async function glide(node, token, click = true) {
    const point = centerOf(node);
    cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    await pause(760, token);
    if (!click) return;
    cursor.classList.remove('fd-click');
    void cursor.offsetWidth;
    cursor.classList.add('fd-click');
    await pause(200, token);
  }

  async function choosePreset(select, value, token) {
    await glide(select, token);
    select.classList.add('fd-flash');
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await pause(420, token);
    select.classList.remove('fd-flash');
  }

  async function tourNote(targetId, comment, token) {
    await glide(toolbar, token);
    pick();
    await pause(350, token);
    targets[0].classList.add('fd-hover');
    await glide(targets[0], token, false);
    await pause(250, token);
    targets[0].classList.remove('fd-hover');
    const target = targets.find(item => item.dataset.target === targetId);
    target.classList.add('fd-hover');
    await glide(target, token);
    choose(target.firstElementChild);
    await pause(550, token);
    const input = panel.querySelector('textarea');
    await glide(input, token);
    for (const character of comment) {
      input.value += character;
      input.dispatchEvent(new Event('input'));
      await pause(34 + Math.random() * 40, token);
    }
    await pause(300, token);
    await glide(panel.querySelector('[type="submit"]'), token);
    input.form.requestSubmit();
    await pause(500, token);
    if (!conversation) {
      await choosePreset(panel.querySelector('#fd-project'), tour.project, token);
      await choosePreset(panel.querySelector('#fd-conversation'), tour.conversation, token);
    } else {
      await pause(1200, token);
    }
    const send = panel.querySelector('.fd-primary');
    await glide(send, token);
    send.classList.add('fd-press');
    const delivery = deliver(send);
    await pause(250, token);
    await glide(terminalBody, token, false);
    await delivery;
  }

  async function playOnce(token) {
    const start = centerOf(terminal);
    cursor.style.transform = `translate(${start.x}px, ${start.y + 40}px)`;
    cursor.hidden = false;
    await pause(1100, token);
    await tourNote(tour.target, tour.comment, token);
    await pause(1800, token);
    visitGuide();
    await pause(800, token);
    await tourNote('care-description', guidePage.comment, token);
    await pause(4200, token);
  }

  // With reduced motion the walkthrough runs once without delays and rests on its final state.
  async function autoplay() {
    playing = true;
    try {
      do {
        clearSession();
        await playOnce(run);
      } while (!reduceMotion.matches);
    } catch (error) {
      if (error !== STOPPED) throw error;
    }
    cursor.hidden = true;
  }

  function stopAutoplay() {
    playing = false;
    cursor.hidden = true;
    clearSession();
  }

  browser.inert = true;
  terminal.inert = true;
  window.addEventListener('resize', keepChosenVisible);
  clearSession();
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !playing) void autoplay();
    else if (!entry.isIntersecting && playing && !reduceMotion.matches) stopAutoplay();
  }, { threshold: .6 }).observe(scene);
})();
