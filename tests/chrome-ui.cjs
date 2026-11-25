// Drives the unpacked extension in Chrome for Testing and checks what a user would see and what a
// native host would receive. Run with the Chrome for Testing binary as argv[2]:
//
//   node tests/chrome-ui.cjs "<chrome>" [scenario name ...]
//
// Destinations are fakes. The native host is tests/fixtures/fake-host.cjs, registered only in a
// temporary profile under a temporary HOME, with a PATH of system directories. Nothing here can
// discover or deliver to a real Claude Code, Codex, tmux or Rex session.
// Set NITPOST_SHOTS to a directory to keep the screenshots the layout checks and failures take.
const {execFileSync, spawn} = require('node:child_process');
const crypto = require('node:crypto');
const {once} = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {isDeepStrictEqual} = require('node:util');
const zlib = require('node:zlib');
const {setTimeout: delay} = require('node:timers/promises');

const extensionId = 'nbodoigokndfjagdocbaobppgepiflpf';
const extensionDir = path.join(__dirname, '../extension');
const fixtures = path.join(__dirname, 'fixtures');
const hostName = 'com.micovi.nitpost';
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const shotsDir = process.env.NITPOST_SHOTS || null;
const SHIFT = 8;
const META = 4;
const jpegPrefix = 'data:image/jpeg;base64,';
// Two fake conversations in one project. Their labels start with different letters, so a keyboard
// user's type-ahead in the list picks one unambiguously.
const conversation = {
  session: 'fake-session',
  block: 'fake-block-1',
  label: 'Codex · site',
  project: '/work/site',
};
const otherConversation = {
  session: 'fake-session',
  block: 'fake-block-2',
  label: 'tmux · site:1.0',
  project: '/work/site',
};

// ---- Results ---------------------------------------------------------------------------------

const results = [];
let scenarioName = '';

// A failed check is recorded and the run continues, so one product bug does not hide the next.
function check(name, ok, detail = '') {
  results.push({scenario: scenarioName, name, ok: Boolean(ok), detail: ok ? '' : String(detail)});
  console.log(
    (ok ? '  ok    ' : '  FAIL  ') + name + (ok || !detail ? '' : '\n          ' + String(detail)),
  );
  return Boolean(ok);
}

function equal(name, actual, expected) {
  const same = isDeepStrictEqual(actual, expected);
  return check(
    name,
    same,
    'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual),
  );
}

function includes(name, text, part) {
  return check(
    name,
    typeof text === 'string' && text.includes(part),
    'expected text containing ' + JSON.stringify(part) + ', got ' + JSON.stringify(text),
  );
}

// Something the run observed that is not a pass or a fail, such as a platform limit.
function observe(text) {
  results.push({scenario: scenarioName, name: text, observed: true, ok: true});
  console.log('  note  ' + text);
}

async function until(what, probe, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await delay(60);
  }
}

// ---- Fixtures --------------------------------------------------------------------------------

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, tail]);
}

// A flat-colour PNG, standing in for the picture of a design the user wants.
function png(width, height, [red, green, blue]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3, Buffer.from([red, green, blue])),
  ]);
  const pixels = zlib.deflateSync(Buffer.concat(Array(height).fill(row)));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixels),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function serveFixtures() {
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://fixture').pathname.slice(1) || 'shop.html';
    const file = path.join(fixtures, path.basename(name));
    if (!name.endsWith('.html') || !fs.existsSync(file)) {
      response.writeHead(404).end('Not a fixture');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- Browser ---------------------------------------------------------------------------------

function pipeRpc(browser) {
  let id = 0;
  let buffer = '';
  const pending = new Map();
  const listeners = new Set();
  browser.stdio[4].setEncoding('utf8').on('data', data => {
    const frames = (buffer + data).split('\0');
    buffer = frames.pop();
    for (const frame of frames) {
      const message = JSON.parse(frame);
      if (message.id) pending.get(message.id)?.(message);
      else for (const listener of listeners) listener(message);
    }
  });
  function rpc(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const seq = ++id;
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 20000);
      pending.set(seq, message => {
        clearTimeout(timer);
        pending.delete(seq);
        if (message.error) reject(new Error(method + ': ' + message.error.message));
        else resolve(message.result);
      });
      browser.stdio[3].write(JSON.stringify({id: seq, method, params, sessionId}) + '\0');
    });
  }
  return {rpc, listeners};
}

// The fake helper, registered where Chrome for Testing looks first: inside the temporary profile.
function fakeHost(home, profile) {
  const statePath = path.join(home, 'host-state.json');
  const logPath = path.join(home, 'host-log.jsonl');
  const manifest = path.join(profile, 'NativeMessagingHosts', hostName + '.json');
  const script = path.join(home, 'fake-host.sh');
  function register(command) {
    fs.mkdirSync(path.dirname(manifest), {recursive: true});
    fs.writeFileSync(script, '#!/bin/sh\n' + command + '\n', {mode: 0o755});
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        name: hostName,
        description: 'Test host',
        path: script,
        type: 'stdio',
        allowed_origins: ['chrome-extension://' + extensionId + '/'],
      }),
    );
  }
  const host = {
    register,
    set(state) {
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
    install() {
      register(
        'exec "' +
          process.execPath +
          '" "' +
          path.join(fixtures, 'fake-host.cjs') +
          '" "' +
          statePath +
          '" "' +
          logPath +
          '"',
      );
    },
    remove() {
      fs.rmSync(manifest, {force: true});
    },
    requests(op) {
      if (!fs.existsSync(logPath)) return [];
      const all = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      return op ? all.filter(request => request.op === op) : all;
    },
    deliveries() {
      return host.requests().filter(request => request.op === 'send' || request.op === 'start');
    },
    forget() {
      fs.rmSync(logPath, {force: true});
    },
  };
  host.set({});
  return host;
}

async function launch(executable, {helper = true, extension = extensionDir} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nitpost-ui-'));
  const profile = path.join(home, 'profile');
  fs.mkdirSync(profile);
  const host = fakeHost(home, profile);
  if (helper) host.install();
  const env = {HOME: home, PATH: systemPath, TMPDIR: os.tmpdir()};
  const browser = spawn(
    executable,
    [
      '--headless',
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--disable-background-networking',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--user-data-dir=' + profile,
      '--load-extension=' + extension,
      '--window-size=1280,800',
      '--hide-scrollbars',
      '--no-proxy-server',
      '--host-resolver-rules=MAP insecure.test 127.0.0.1',
      '--force-prefers-reduced-motion',
      'about:blank',
    ],
    {env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']},
  );
  const {rpc, listeners} = pipeRpc(browser);
  const workerUrl = 'chrome-extension://' + extensionId + '/background.js';
  let workerSession = null;

  async function attachWorker() {
    return until('the extension service worker', async () => {
      const {targetInfos} = await rpc('Target.getTargets');
      const target = targetInfos.find(
        info => info.type === 'service_worker' && info.url === workerUrl,
      );
      if (!target) return null;
      return (await rpc('Target.attachToTarget', {targetId: target.targetId, flatten: true}))
        .sessionId;
    });
  }

  // Evaluates in the service worker, which Chrome may have restarted since the last call.
  async function worker(expression) {
    for (let attempt = 0; ; attempt++) {
      try {
        workerSession ??= await attachWorker();
        const result = await rpc(
          'Runtime.evaluate',
          {expression, awaitPromise: true, returnByValue: true},
          workerSession,
        );
        if (result.exceptionDetails)
          throw new Error(result.exceptionDetails.exception?.description ?? 'Worker threw');
        return result.result.value;
      } catch (error) {
        workerSession = null;
        if (attempt === 2) throw error;
        await delay(200);
      }
    }
  }

  async function close() {
    if (browser.exitCode === null) {
      const done = once(browser, 'exit');
      browser.kill();
      await done;
    }
    fs.rmSync(home, {recursive: true, force: true});
  }

  const session = {
    rpc,
    listeners,
    worker,
    host,
    home,
    close,
    stored: key =>
      worker(
        'chrome.storage.local.get(' +
          JSON.stringify(key ?? null) +
          ')' +
          (key ? '.then(all => all[' + JSON.stringify(key) + '])' : ''),
      ),
    seed: values => worker('chrome.storage.local.set(' + JSON.stringify(values) + ')'),
    grantClipboard: origin =>
      rpc('Browser.grantPermissions', {
        origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      }),
  };
  session.open = (url, size) => openPage(session, url, size);
  await worker("typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id)");
  return session;
}

// ---- Page and overlay ------------------------------------------------------------------------

// The functions below run inside the page, with the overlay's closed shadow root to read from.
// `page.overlay` sends `overlayParts` along with the function it calls.
function textOf(node) {
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
}

function isShown(node) {
  return Boolean(node) && node.getClientRects().length > 0;
}

function boxOf(node) {
  const rect = node.getBoundingClientRect();
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

function listView(node) {
  if (!node) return null;
  const options = [...node.options].map(option => ({
    value: option.value,
    text: option.textContent,
    disabled: option.disabled,
  }));
  return {
    value: node.value,
    disabled: node.disabled,
    shown: isShown(node),
    ...boxOf(node),
    options,
  };
}

function tileView(tile) {
  return {
    image: tile.dataset.image,
    state: tile.dataset.state,
    name: textOf(tile.querySelector('figcaption strong')),
    label: tile.getAttribute('aria-label'),
    painted: Boolean(tile.querySelector('canvas')?.width > 1),
    action: textOf(tile.querySelector('figcaption button')),
  };
}

function editorView(editor) {
  if (editor.hidden) return null;
  return {
    scope: editor.dataset.scope,
    context: textOf(editor.querySelector('code, .targets')),
    text: textOf(editor),
    comment: editor.querySelector('textarea').value,
    placeholder: editor.querySelector('textarea').placeholder,
    excerpt: editor.querySelector('.excerpt-row')?.dataset.state ?? null,
    tiles: [...editor.querySelectorAll('.tile')].map(tileView),
    ...boxOf(editor),
  };
}

function focusView(active) {
  if (!active) return null;
  const style = getComputedStyle(active);
  const outlined = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  return {
    tag: active.localName,
    control: active.dataset.control ?? null,
    id: active.id,
    name: active.getAttribute('aria-label') || active.title || textOf(active),
    ring: outlined || style.boxShadow !== 'none',
    visible: active.matches(':focus-visible'),
    ...boxOf(active),
  };
}

function noteView(node) {
  return {
    scope: node.dataset.scope,
    attempt: node.dataset.attempt ?? null,
    comment: textOf(node.querySelector('.comment')),
    meta: textOf(node.querySelector('.card-meta')),
    lost: !node.querySelector('.lost').hidden,
    pin: boxOf(node.querySelector('.pin')),
    ...boxOf(node),
  };
}

function controlView(node) {
  return {
    name: node.dataset.control,
    text: textOf(node),
    disabled: node.disabled === true,
    title: node.title,
    pressed: node.getAttribute('aria-pressed'),
    ...boxOf(node),
  };
}

// The last send and what the panel says about the helper and the conversations.
function panelView(one, all) {
  const attempt = one('.attempt');
  const route = one('.route');
  return {
    panel: textOf(one('.panel')),
    attempt: attempt && {
      status: attempt.dataset.status,
      title: textOf(attempt.querySelector('.panel-title')),
      time: textOf(attempt.querySelector('time')),
      datetime: attempt.querySelector('time')?.dateTime,
      text: textOf(attempt),
    },
    facts: Object.fromEntries(
      all('.fact').map(node => [
        node.dataset.fact,
        {state: node.dataset.state, text: textOf(node)},
      ]),
    ),
    route: route && {
      connection: route.dataset.connection,
      eligible: route.dataset.eligible,
      gone: route.hasAttribute('data-gone'),
      text: textOf(route),
    },
    checks: all('.checks li').map(node => ({route: node.dataset.route, text: textOf(node)})),
    copybox: one('.copybox') && {
      lead: textOf(one('.copybox .panel-title')),
      value: one('.copy-text').value,
    },
  };
}

// Everything the checks read, in one snapshot. `this` is the shadow root.
function overlayView() {
  const all = selector => [...this.querySelectorAll(selector)];
  const one = selector => this.querySelector(selector);
  const outline = one('.outline');
  return {
    mode: one('.dock').dataset.mode,
    busy: one('[aria-busy="true"]') !== null,
    pick: one('.pickbar')?.dataset.pick ?? null,
    lead: textOf(one('.instructions strong')),
    pass: one('.shield').hasAttribute('data-pass'),
    outline: outline.hidden ? null : {tag: textOf(one('.tag-name')), ...boxOf(outline)},
    marks: all('.mark-box').filter(isShown).length,
    status: textOf(one('.status')),
    statusError: one('.status').classList.contains('error'),
    spoken: textOf(one('.spoken')),
    shortcut: textOf(one('.shortcut-key')),
    connection: one('.toolbar')?.dataset.connection ?? null,
    controls: all('[data-control]').filter(isShown).map(controlView),
    notes: all('.note').map(noteView),
    editor: editorView(one('.editor')),
    cardTiles: all('.pins .tile').map(tileView),
    project: listView(one('#nitpost-project')),
    target: listView(one('#nitpost-target')),
    focus: focusView(this.activeElement),
    ...panelView(one, all),
  };
}

const overlayParts = [
  textOf,
  isShown,
  boxOf,
  listView,
  tileView,
  editorView,
  focusView,
  noteView,
  controlView,
  panelView,
];

// The centre of the overlay node that matches, for a pointer to aim at.
function overlayPoint({selector, index, text}) {
  const nodes = [...this.querySelectorAll(selector)].filter(
    node => node.getClientRects().length > 0 && (text === null || node.textContent.trim() === text),
  );
  const rect = nodes[index]?.getBoundingClientRect();
  return rect ? {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2} : null;
}

function shadowOf(node) {
  if (node.shadowRoots?.length && node.attributes?.includes('manual')) return node.shadowRoots[0];
  for (const child of node.children ?? []) {
    const found = shadowOf(child);
    if (found) return found;
  }
  return null;
}

function pointer(send) {
  const mouse = (type, x, y, more = {}) => send('Input.dispatchMouseEvent', {type, x, y, ...more});
  const input = {
    async move(x, y) {
      await mouse('mouseMoved', x, y);
      await delay(50);
    },
    down: (x, y, modifiers = 0) =>
      mouse('mousePressed', x, y, {button: 'left', buttons: 1, clickCount: 1, modifiers}),
    up: (x, y, modifiers = 0) =>
      mouse('mouseReleased', x, y, {button: 'left', clickCount: 1, modifiers}),
    async click(x, y, modifiers = 0) {
      await input.move(x, y);
      await input.down(x, y, modifiers);
      await input.up(x, y, modifiers);
      await delay(80);
    },
    async drag(x1, y1, x2, y2) {
      await input.move(x1, y1);
      await input.down(x1, y1);
      for (let step = 1; step <= 5; step++) {
        await mouse('mouseMoved', x1 + ((x2 - x1) * step) / 5, y1 + ((y2 - y1) * step) / 5, {
          button: 'left',
          buttons: 1,
        });
        await delay(20);
      }
      await input.up(x2, y2);
      await delay(80);
    },
  };
  return input;
}

function keyboard(send) {
  const input = {
    async key(key, {modifiers = 0, commands} = {}) {
      const codes = {Enter: 13, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ' ': 32};
      const base = {
        key,
        code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
        modifiers,
        windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0),
      };
      const text =
        key === 'Enter' ? '\r' : key.length === 1 && !(modifiers & META) ? key : undefined;
      await send('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown',
        ...base,
        text,
        commands,
      });
      await send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
      await delay(80);
    },
    async type(text) {
      await send('Input.insertText', {text});
      await delay(50);
    },
    paste: () => input.key('v', {modifiers: META, commands: ['paste']}),
  };
  return input;
}

// Reading the overlay and pressing its controls. `page` supplies send, click and the tab to
// activate.
function overlayAccess(session, page) {
  const access = {
    // Calls `fn` with the overlay's shadow root as `this`. Null while the overlay is closed.
    async overlay(fn, argument) {
      const {root} = await page.send('DOM.getDocument', {depth: 2, pierce: true});
      const shadow = shadowOf(root);
      if (!shadow) return null;
      const {object} = await page.send('DOM.resolveNode', {backendNodeId: shadow.backendNodeId});
      const result = await page.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        awaitPromise: true,
        functionDeclaration:
          'function (argument) {' +
          overlayParts.join('\n') +
          '\nreturn (' +
          fn +
          ').call(this, argument); }',
        arguments: [{value: argument ?? null}],
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      }
      return result.result.value;
    },
    view: () => access.overlay(overlayView),
    // Waits until the overlay is open, idle and `probe(view)` holds, then returns that view.
    async when(what, probe = () => true, timeout) {
      let last = null;
      try {
        return await until(
          what,
          async () => {
            last = await access.view();
            return last && !last.busy && probe(last) ? last : null;
          },
          timeout,
        );
      } catch (error) {
        error.message +=
          '. Overlay: ' +
          JSON.stringify(
            last && {
              mode: last.mode,
              status: last.status,
              connection: last.connection,
              attempt: last.attempt?.status,
              controls: last.controls.map(item => item.name),
            },
          );
        throw error;
      }
    },
    // A toolbar click or the shortcut always lands on the tab in front.
    async activate() {
      await session.rpc('Target.activateTarget', {targetId: page.targetId});
      await session.rpc('Extensions.triggerAction', {id: extensionId, targetId: page.tabId});
    },
    async open() {
      await access.activate();
      return access.when('the overlay to open', view => view.mode !== 'idle');
    },
    async control(name, index = 0) {
      const view = await access.view();
      return view?.controls.filter(item => item.name === name)[index] ?? null;
    },
    // A real pointer click on one of the overlay's named controls.
    async press(name, index = 0) {
      const found = await until('the “' + name + '” control', async () => {
        const item = await access.control(name, index);
        return item && !item.disabled ? item : null;
      });
      await page.click(found.x + found.width / 2, found.y + found.height / 2);
    },
    // A real pointer click on any overlay node, for the few that carry no control name.
    async clickOverlay(selector, {index = 0, text = null} = {}) {
      const point = await until('overlay node ' + selector, () =>
        access.overlay(overlayPoint, {selector, index, text}),
      );
      await page.click(point.x, point.y);
    },
  };
  return access;
}

function pageAccess(send) {
  const access = {
    async eval(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      }
      return result.result.value;
    },
    loaded: href =>
      until(href + ' to load', () =>
        access.eval('document.readyState === "complete" && location.href').then(
          now => now === href,
          () => false,
        ),
      ),
    async goto(next) {
      const result = await send('Page.navigate', {url: next});
      if (result.errorText) throw new Error('Could not open ' + next + ': ' + result.errorText);
      await access.loaded(next);
    },
    async reload() {
      const href = await access.eval('location.href');
      await send('Page.reload');
      await delay(150);
      await access.loaded(href);
    },
    async resize(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(250);
    },
    // Where a page element is in the viewport, asked in a way a hostile page cannot redirect.
    async rect(id) {
      const rect = await access.eval(
        '(() => { const node = Document.prototype.getElementById.call(document, ' +
          JSON.stringify(id) +
          '); const r = Element.prototype.getBoundingClientRect.call(node);' +
          'return {x: r.x, y: r.y, width: r.width, height: r.height}; })()',
      );
      return {...rect, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2};
    },
    async shot(name) {
      if (!shotsDir) return;
      const {data} = await send('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(data, 'base64'));
    },
  };
  return access;
}

async function openPage(session, url, {width = 1280, height = 800} = {}) {
  const tabs = async () =>
    (await session.rpc('Target.getTargets', {filter: [{}]})).targetInfos
      .filter(info => info.type === 'tab')
      .map(info => info.targetId);
  const before = await tabs();
  const {targetId} = await session.rpc('Target.createTarget', {url: 'about:blank'});
  const tabId = (await tabs()).find(id => !before.includes(id));
  const {sessionId} = await session.rpc('Target.attachToTarget', {targetId, flatten: true});
  const send = (method, params) => session.rpc(method, params, sessionId);
  const events = [];
  session.listeners.add(message => {
    if (message.sessionId === sessionId) events.push(message);
  });
  for (const domain of ['Page', 'Runtime', 'DOM']) await send(domain + '.enable');
  await send('Emulation.setFocusEmulationEnabled', {enabled: true});
  const page = {
    send,
    targetId,
    tabId,
    events,
    ...pageAccess(send),
    ...pointer(send),
    ...keyboard(send),
  };
  Object.assign(page, overlayAccess(session, page));
  page.clickPage = async (id, modifiers = 0) => {
    const rect = await page.rect(id);
    await page.click(rect.x + Math.min(12, rect.width / 2), rect.cy, modifiers);
  };
  await page.resize(width, height);
  await page.goto(url);
  return page;
}

// ---- Flows a user repeats ----------------------------------------------------------------------

const notesKey = url => 'notes:' + url;
const attemptKey = url => 'attempt:' + url;

// Types a comment into the open editor and saves it. Leaves the picker open, as the overlay does.
async function writeNote(page, comment, {kind = 'change', omit = false, omitText = false} = {}) {
  const before = (await page.view()).notes.length;
  await page.when('the note editor', view => view.editor);
  if (kind === 'question') await page.clickOverlay('.editor [data-kind="question"]');
  if (omit) await page.press('omit-screenshot');
  if (omitText) await page.press('omit-excerpt');
  await page.clickOverlay('.editor textarea');
  await page.type(comment);
  await page.press('save');
  return page.when(
    'the note to be saved',
    view => view.mode === 'pick' && view.notes.length === before + 1,
  );
}

async function addNote(page, id, comment, options) {
  await page.clickPage(id);
  return writeNote(page, comment, options);
}

// The review bar once discovery has finished.
function settled(page, probe = () => true, timeout) {
  return page.when(
    'the review bar to finish checking',
    view => view.mode === 'review' && view.connection !== 'checking' && probe(view),
    timeout,
  );
}

async function review(page, probe, timeout) {
  await page.press('review');
  return settled(page, probe, timeout);
}

async function openReview(page, probe) {
  await page.activate();
  return settled(page, probe);
}

async function sendNotes(page, status, control = 'send') {
  await page.press(control);
  return settled(page, view => view.attempt?.status === status);
}

// Chooses an option of one of the bar's lists the way a keyboard user does: Tab to it, then type.
async function choose(page, id, letters) {
  if ((await page.view()).focus?.id !== id) await tabTo(page, focus => focus.id === id);
  for (const letter of letters) await page.key(letter);
}

async function chooseConversation(page, letters) {
  await choose(page, 'nitpost-project', 's');
  await page.when(
    'the project to be chosen',
    view => view.project.value === '/work/site' && !view.target.disabled,
  );
  await choose(page, 'nitpost-target', letters);
  return page.when(
    'the conversation to be chosen',
    view =>
      view.target.value !== '' &&
      view.controls.some(control => control.name === 'send' && !control.disabled),
  );
}

function control(view, name) {
  return view.controls.find(item => item.name === name) ?? null;
}

// The clipboard belongs to the headless browser, not to the Mac. A secure page reads it back.
async function clipboard(reader) {
  return reader.eval('navigator.clipboard.readText()');
}

// Size and corner colour of a stored JPEG, decoded by the page.
async function imageInfo(page, dataUrl) {
  return page.eval(
    '(async () => { const bitmap = await createImageBitmap(await (await fetch(' +
      JSON.stringify(dataUrl) +
      ')).blob()); const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);' +
      'const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);' +
      'const corner = [...context.getImageData(3, 3, 1, 1).data].slice(0, 3);' +
      'return {width: bitmap.width, height: bitmap.height, corner}; })()',
  );
}

function near(colour, expected) {
  return (
    Array.isArray(colour) &&
    colour.every((channel, index) => Math.abs(channel - expected[index]) <= 40)
  );
}

function isJpeg(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(jpegPrefix) &&
    value.length > jpegPrefix.length + 200
  );
}

function recent(iso) {
  return Math.abs(Date.now() - Date.parse(iso)) < 120000;
}

async function withSession(ctx, options, body) {
  const session = await ctx.launch(options);
  try {
    await session.grantClipboard(ctx.origin);
    await session.grantClipboard(ctx.secondOrigin);
    return await body(session);
  } finally {
    await session.close();
  }
}

// ---- Scenarios -------------------------------------------------------------------------------

function checkCopiedText(text, url, area) {
  includes('copied text names the page', text, 'Page: ' + url);
  includes(
    'copied text has the element note’s kind and comment',
    text,
    '## 1. Change request\n\nMake the heading smaller',
  );
  includes(
    'copied text has the selector and excerpt',
    text,
    '- Element: `#title` with the text “Lounge chair”',
  );
  includes('copied text has the question', text, '## 2. Question\n\nWhy is this button blue?');
  includes(
    'copied text has the area rect and says no element was selected',
    text,
    '- Area: ' +
      area.width +
      ' × ' +
      area.height +
      ' CSS px, starting ' +
      area.x +
      ' px from the left and ' +
      area.y +
      ' px from the top of the document. No element was selected.',
  );
  includes(
    'copied text lists the grouped selectors',
    text,
    '- Elements (one note for all 3):\n  1. `#oak` with the text “Oak”\n' +
      '  2. `#walnut` with the text “Walnut”\n  3. `#ash`',
  );
  includes('copied text has the viewport', text, '- Viewport: 1280 × 800 CSS px');
  includes(
    'copied text says images stay behind',
    text,
    'is kept in Nitpost and is not included in this text.',
  );
  const areaPart = text.slice(text.indexOf('## 3.'), text.indexOf('## 4.'));
  check('the area note has no selector in the copied text', !areaPart.includes('`'), areaPart);
}

async function addFourNotes(page) {
  await addNote(page, 'title', 'Make the heading smaller');
  await addNote(page, 'buy', 'Why is this button blue?', {kind: 'question'});
  await page.press('pick-area');
  await page.drag(950, 300, 1150, 420);
  await writeNote(page, 'Too much empty space here');
  await page.press('pick-group');
  for (const id of ['oak', 'walnut', 'ash']) await page.clickPage(id);
  await page.press('group-done');
  await writeNote(page, 'Make these three the same height');
}

async function copyWithoutHelper(ctx) {
  await withSession(ctx, {helper: false}, async session => {
    const url = ctx.origin + '/shop.html?copy=1';
    const page = await session.open(url);
    await page.open();
    await addFourNotes(page);
    let view = await review(page);
    equal('the bar reports the helper as missing', view.connection, 'missing');
    includes(
      'the panel says the helper is not installed',
      view.facts.helper?.text,
      'Not installed',
    );
    includes('the panel points to Copy for agent', view.facts.helper?.text, 'Copy for agent');
    check('Send is unavailable without a helper', control(view, 'send')?.disabled === true);
    await page.shot('copy-helper-missing');
    await page.press('copy');
    view = await page.when('the copy to be reported', next => next.status.includes('Copied'));
    includes(
      'status says what was copied and that drafts are unchanged',
      view.status,
      'Copied 4 notes as text for any agent. Your drafts are unchanged.',
    );
    const stored = await session.stored(notesKey(url));
    checkCopiedText(await clipboard(page), url, stored[2].rect);
    equal('all four drafts are still shown', view.notes.length, 4);
    equal(
      'all four drafts are still stored',
      stored.map(note => note.comment),
      [
        'Make the heading smaller',
        'Why is this button blue?',
        'Too much empty space here',
        'Make these three the same height',
      ],
    );
    equal('no attempt was recorded', await session.stored(attemptKey(url)), undefined);
    equal('no request reached a native host', session.host.requests(), []);
  });
}

async function copyOnInsecurePage(ctx) {
  await withSession(ctx, {helper: false}, async session => {
    const url = ctx.insecureOrigin + '/shop.html';
    const page = await session.open(url).catch(error => {
      observe(
        'The insecure host name could not be mapped, so only the secure path was covered: ' +
          error.message,
      );
      return null;
    });
    if (!page) return;
    equal('the page is not a secure context', await page.eval('isSecureContext'), false);
    equal(
      'the async clipboard is absent there',
      await page.eval('typeof navigator.clipboard'),
      'undefined',
    );
    const reader = await session.open(ctx.origin + '/account.html');
    await reader.eval('navigator.clipboard.writeText("before the copy")');
    await page.send('Page.bringToFront');
    await page.open();
    await addNote(page, 'title', 'Insecure page note');
    await review(page);
    await page.press('copy');
    const view = await page.when('the copy to be reported', next => next.status !== '');
    await page.shot('copy-insecure');
    includes(
      'status reports a copy on an insecure page',
      view.status,
      'Copied 1 note as text for any agent.',
    );
    equal('no manual copy box is left open', view.copybox, null);
    const text = await clipboard(reader);
    includes('the clipboard holds the note from the insecure page', text, 'Page: ' + url);
    includes('with its comment', text, 'Insecure page note');
    equal('the draft is still stored', (await session.stored(notesKey(url))).length, 1);
  });
}

async function copyAfterInvalidation(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?orphan=1';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'Written before the extension reloaded');
    await review(page);
    // Loading the unpacked extension again replaces it, as an update does. The page keeps the old
    // content script, whose connection to the extension is now dead.
    equal(
      'the extension reloads under the same ID',
      (await session.rpc('Extensions.loadUnpacked', {path: extensionDir})).id,
      extensionId,
    );
    await delay(1200);
    await page.eval('navigator.clipboard.writeText("before the copy")');
    await page.press('copy');
    let view = await page.when('the copy to be reported', next => next.status !== '');
    includes(
      'Copy for agent works after the extension context is gone',
      view.status,
      'Copied 1 note',
    );
    includes(
      'the clipboard holds the note',
      await clipboard(page),
      'Written before the extension reloaded',
    );
    await page.press('check');
    view = await page.when(
      'the lost connection to be shown',
      next => next.connection === 'orphaned',
    );
    includes(
      'the panel explains the lost connection',
      view.panel,
      'Nitpost lost its connection to this tab',
    );
    equal(
      'the note is still on screen',
      view.notes.map(note => note.comment),
      ['Written before the extension reloaded'],
    );
    check('Send is not offered without the extension', control(view, 'send') === null);
    await page.shot('copy-orphaned');
    await page.eval('navigator.clipboard.writeText("before the second copy")');
    await page.press('copy');
    await page.when('the second copy', next => next.status.includes('Copied'));
    includes(
      'Copy for agent still works in the orphaned state',
      await clipboard(page),
      'Written before the extension reloaded',
    );
    // The new worker sleeps until an event. A toolbar click in another tab wakes it.
    const other = await session.open(ctx.origin + '/account.html');
    await other.open();
    equal('the draft survived in storage', (await session.stored(notesKey(url))).length, 1);
    equal('no attempt was recorded', await session.stored(attemptKey(url)), undefined);
    equal('nothing was delivered', session.host.deliveries(), []);
  });
}

const routeChecks = [
  {route: 'claude', found: 1, eligible: 0, detail: 'Found 1 session, but none has a peer inbox.'},
  {route: 'codex', found: 2, eligible: 0, detail: 'Found 2 loaded threads, but none is idle.'},
  {route: 'tmux', found: 0, eligible: 0, detail: 'tmux is not on the helper’s PATH.'},
  {route: 'rex', found: 0, eligible: 0, detail: 'Rex is not on the helper’s PATH.'},
];

async function recheck(page, session, connection) {
  const before = session.host.requests('targets').length;
  await page.press('check');
  const view = await page.when(
    'Check again to finish',
    next =>
      next.mode === 'review' &&
      next.connection === connection &&
      next.spoken.startsWith('Checked again.'),
  );
  return {view, asked: session.host.requests('targets').length - before};
}

// No helper, then a helper that quits, then one that refuses to list.
async function helperStates(session, page) {
  const view = await review(page);
  equal('missing: the bar says so', view.connection, 'missing');
  equal('missing: helper fact is a problem', view.facts.helper?.state, 'problem');
  includes(
    'missing: conversations were not checked',
    view.facts.conversations?.text,
    'Not checked',
  );
  includes(
    'missing: last send says nothing was sent',
    view.facts['last-send']?.text,
    'Nothing has been sent from this page.',
  );
  check('missing: the destination lists are hidden', !view.project.shown && !view.target.shown);

  session.host.install();
  session.host.set({discovery: 'exit'});
  let result = await recheck(page, session, 'unreachable');
  includes(
    'unreachable: helper fact says it is not responding',
    result.view.facts.helper?.text,
    'Not responding',
  );
  check('unreachable: Send is unavailable', control(result.view, 'send')?.disabled === true);
  await page.shot('connection-unreachable');

  session.host.set({listing: {ok: false, error: 'The helper could not read its session list.'}});
  result = await recheck(page, session, 'error');
  includes(
    'refused listing: the helper itself is reported as connected',
    result.view.facts.helper?.text,
    'Connected.',
  );
  includes(
    'refused listing: the conversations fact repeats the helper’s reason',
    result.view.facts.conversations?.text,
    'The helper could not read its session list.',
  );
  check('refused listing: Send is unavailable', control(result.view, 'send')?.disabled === true);
}

// A helper that answers: nothing eligible, then two conversations, then the saved one gone.
async function conversationStates(session, page) {
  session.host.set({targets: [], checks: routeChecks});
  let result = await recheck(page, session, 'connected');
  equal('none eligible: Check again asked the helper once', result.asked, 1);
  includes(
    'none eligible: helper fact says connected',
    result.view.facts.helper?.text,
    'Connected.',
  );
  equal(
    'none eligible: conversations fact is a problem',
    result.view.facts.conversations?.state,
    'problem',
  );
  includes(
    'none eligible: the fact says none is ready',
    result.view.facts.conversations?.text,
    'None is ready to receive notes.',
  );
  equal(
    'none eligible: each route’s check is shown',
    result.view.checks.map(item => item.route),
    ['claude', 'codex', 'tmux', 'rex'],
  );
  includes(
    'none eligible: a check carries the helper’s reason',
    result.view.checks[1]?.text,
    'Codex Found 2 loaded threads, but none is idle.',
  );
  check('none eligible: Send is unavailable', control(result.view, 'send')?.disabled === true);
  await page.shot('connection-none-eligible');

  session.host.set({targets: [conversation, otherConversation]});
  result = await recheck(page, session, 'connected');
  includes(
    'connected: conversations are counted',
    result.view.facts.conversations?.text,
    '2 conversations ready to receive notes.',
  );
  equal(
    'connected: the project is offered',
    result.view.project.options.map(option => option.text),
    ['Choose a project', 'site', 'Choose folder…'],
  );
  const view = await chooseConversation(page, 'c');
  equal('connected: the chosen conversation is selected', view.target.value, conversation.block);
  check('connected: Send is available', control(view, 'send')?.disabled === false);

  session.host.set({targets: [otherConversation]});
  result = await recheck(page, session, 'connected');
  check('gone: the panel marks the saved conversation as gone', result.view.route?.gone === true);
  includes(
    'gone: the fact names it and says the notes are kept',
    result.view.facts.conversations?.text,
    conversation.label +
      ' is no longer available. It may have closed or be busy. Your notes are still here.',
  );
  check(
    'gone: Send is unavailable until another conversation is chosen',
    control(result.view, 'send')?.disabled === true,
  );
  equal('gone: the note is still shown', result.view.notes.length, 1);
  await page.shot('connection-saved-gone');
}

async function connectionStates(ctx) {
  await withSession(ctx, {helper: false}, async session => {
    const url = ctx.origin + '/shop.html?connection=1';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'A note that waits for a destination');
    await helperStates(session, page);
    await conversationStates(session, page);
    equal('Check again never sent anything', session.host.deliveries(), []);
    equal('no attempt was recorded', await session.stored(attemptKey(url)), undefined);
  });
}

// What each helper answer must look like to the user. `kept` says whether the notes stay as drafts.
const receipts = {
  confirmed: {
    reply: {ok: true, receipt: 'confirmed', notice: 'Codex accepted the turn.'},
    title: 'Received by Codex · site',
    wording: 'The agent accepted 1 note',
    kept: false,
  },
  submitted: {
    reply: {ok: true, receipt: 'submitted', notice: 'Typed into the pane.'},
    title: 'Entered in Codex · site',
    wording: 'this does not confirm it read them',
    kept: false,
  },
  unconfirmed: {
    reply: {ok: true, receipt: 'unconfirmed', notice: 'Posted to the inbox.'},
    title: 'Posted to Codex · site, no receipt',
    wording: 'Nothing confirms the agent picked them up.',
    kept: true,
    label: 'Posted, no receipt',
  },
  failed: {
    reply: {
      ok: false,
      error: 'That conversation closed before the notes were typed.',
      uncertain: false,
    },
    title: 'Not sent to Codex · site',
    wording: 'That conversation closed before the notes were typed. Your notes are still here.',
    kept: true,
    label: 'Not sent',
  },
  unknown: {
    reply: {ok: false, error: 'The pane stopped responding after typing began.', uncertain: true},
    title: 'No result recorded for Codex · site',
    wording: 'they may or may not have arrived',
    kept: true,
    label: 'Send result unknown',
  },
};

function deliveriesFrom(session, url) {
  return session.host.deliveries().filter(request => request.page === url);
}

// After a reload the record is reached the way a user reaches it: the list when notes remain,
// otherwise the picker's “Last send” button.
async function reopenAttempt(page, kept) {
  await page.reload();
  if (kept) return openReview(page, view => view.attempt);
  const view = await page.open();
  equal(
    'with no notes left the picker offers “Last send”',
    control(view, 'review')?.text,
    'Last send',
  );
  await page.press('review');
  return page.when('the last send', next => next.mode === 'review' && next.attempt);
}

function checkAttemptControls(status, view) {
  const uncertain = status === 'unconfirmed' || status === 'unknown';
  if (!receipts[status].kept) return;
  equal(
    status + ': the note is marked with the attempt',
    view.notes.map(note => note.attempt),
    [status],
  );
  includes(
    status + ': the note card carries the label',
    view.notes[0]?.meta,
    receipts[status].label,
  );
  equal(
    status + ': plain Send is ' + (uncertain ? 'unavailable' : 'available'),
    control(view, 'send')?.disabled,
    uncertain,
  );
  equal(
    status +
      ': Send again, Mark as received and Keep as drafts are ' +
      (uncertain ? 'offered' : 'not offered'),
    ['resend', 'received', 'dismiss'].map(name => control(view, name) !== null),
    Array(3).fill(uncertain),
  );
  if (uncertain) {
    equal(
      status + ': the disabled Send says why',
      control(view, 'send')?.title,
      'Decide what happened to the earlier batch first.',
    );
  }
}

async function attemptFor(session, ctx, status) {
  const expected = receipts[status];
  const url = ctx.origin + '/shop.html?attempt=' + status;
  const page = await session.open(url);
  await page.open();
  await addNote(page, 'title', 'Note for the ' + status + ' case');
  await review(page, view => control(view, 'send')?.disabled === false);
  session.host.set({targets: [conversation], send: expected.reply});
  const view = await sendNotes(page, status);
  await page.shot('attempt-' + status);
  check(
    status + ': the title names the result and the conversation',
    view.attempt.title.startsWith(expected.title),
    view.attempt.title,
  );
  check(
    status + ': the time of the attempt is shown',
    view.attempt.time.length > 0 && recent(view.attempt.datetime),
    JSON.stringify([view.attempt.time, view.attempt.datetime]),
  );
  includes(status + ': the wording matches what is known', view.attempt.text, expected.wording);
  equal(
    status + ': notes are ' + (expected.kept ? 'kept' : 'removed'),
    view.notes.length,
    expected.kept ? 1 : 0,
  );
  equal(
    status + ': storage agrees',
    ((await session.stored(notesKey(url))) ?? []).length,
    expected.kept ? 1 : 0,
  );
  equal(
    status + ': the stored record has the status',
    (await session.stored(attemptKey(url)))?.status,
    status,
  );
  checkAttemptControls(status, view);
  equal(status + ': one request reached the helper', deliveriesFrom(session, url).length, 1);
  const again = await reopenAttempt(page, expected.kept);
  equal(
    status + ': the same record shows after a reload',
    [again.attempt.status, again.attempt.title, again.attempt.datetime],
    [view.attempt.status, view.attempt.title, view.attempt.datetime],
  );
  checkAttemptControls(status, again);
  return {page, url};
}

async function attemptRecords(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const pages = {};
    for (const status of Object.keys(receipts))
      pages[status] = await attemptFor(session, ctx, status);

    let {page, url} = pages.unconfirmed;
    session.host.set({targets: [conversation], send: receipts.confirmed.reply});
    let view = await sendNotes(page, 'confirmed', 'resend');
    equal('Send again delivers exactly once more', deliveriesFrom(session, url).length, 2);
    equal('Send again clears the notes once confirmed', view.notes.length, 0);

    ({page, url} = pages.unknown);
    await page.press('received');
    view = await page.when(
      'the notes to be cleared',
      next => next.mode === 'review' && !next.attempt,
    );
    includes(
      'Mark as received says the notes are cleared',
      view.status,
      'Marked as received. Those notes are cleared.',
    );
    equal(
      'Mark as received removes the notes',
      [view.notes.length, await session.stored(notesKey(url))],
      [0, undefined],
    );
    equal('Mark as received removes the record', await session.stored(attemptKey(url)), undefined);
    equal('Mark as received sends nothing', deliveriesFrom(session, url).length, 1);

    ({page, url} = pages.failed);
    view = await sendNotes(page, 'confirmed');
    equal(
      'a failed batch goes out with a plain Send, once',
      deliveriesFrom(session, url).map(request => request.accepted),
      [false, true],
    );
  });
}

async function silentHelper(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?attempt=silent';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'Note for a helper that goes silent');
    await review(page, view => control(view, 'send')?.disabled === false);
    session.host.set({targets: [conversation], delivery: 'exit'});
    let view = await sendNotes(page, 'unknown');
    includes(
      'a helper that quits mid-send is reported as unknown',
      view.attempt.title,
      'No result recorded for Codex · site',
    );
    includes('with the reason', view.attempt.text, 'The companion did not confirm delivery.');
    equal(
      'the note is kept',
      view.notes.map(note => note.attempt),
      ['unknown'],
    );
    await page.shot('attempt-silent-helper');
    await page.press('dismiss');
    view = await settled(page, next => !next.attempt);
    includes(
      'Keep as drafts says so',
      view.status,
      'Kept as drafts. They go out with your next send.',
    );
    equal(
      'Keep as drafts keeps the note as an ordinary draft',
      view.notes.map(note => note.attempt),
      [null],
    );
    equal('Keep as drafts drops the record', await session.stored(attemptKey(url)), undefined);
    equal('Keep as drafts makes Send available again', control(view, 'send')?.disabled, false);
    equal('Keep as drafts sends nothing', deliveriesFrom(session, url).length, 1);

    const interruptedUrl = ctx.origin + '/shop.html?attempt=interrupted';
    await session.seed({
      [notesKey(interruptedUrl)]: [
        {
          id: 'interrupted-1',
          scope: 'element',
          kind: 'change',
          selector: '#title',
          text: 'Lounge chair',
          comment: 'Sent just before Chrome stopped the worker',
          width: 1280,
          height: 800,
        },
      ],
      [attemptKey(interruptedUrl)]: {
        at: Date.now() - 60000,
        status: 'pending',
        ids: ['interrupted-1'],
        count: 1,
        target: {
          label: conversation.label,
          project: conversation.project,
          session: conversation.session,
          block: conversation.block,
        },
        detail: '',
      },
    });
    const interrupted = await session.open(interruptedUrl);
    view = await openReview(interrupted, next => next.attempt);
    equal(
      'a record left pending by an interrupted worker reads as unknown',
      view.attempt.status,
      'unknown',
    );
    includes(
      'and says Chrome stopped Nitpost',
      view.attempt.text,
      'Chrome stopped Nitpost before the helper answered.',
    );
    equal('its note cannot go out with a plain Send', control(view, 'send')?.disabled, true);
  });
}

async function legacyHelper(ctx) {
  await withSession(ctx, {}, async session => {
    const old = {targets: [conversation], capabilities: {ok: true, shots: true}};
    session.host.set(old);
    const areaUrl = ctx.origin + '/shop.html?legacy=area';
    let page = await session.open(areaUrl);
    await page.open();
    await page.press('pick-area');
    await page.drag(950, 300, 1150, 420);
    await writeNote(page, 'Area note for a helper without payload 2');
    await review(page, view => control(view, 'send')?.disabled === false);
    let view = await sendNotes(page, 'failed');
    includes(
      'a helper without payload 2 is refused an area note',
      view.attempt.text,
      'This Nitpost helper cannot receive area notes, grouped elements or reference images. ' +
        'Update the helper, or use Copy for agent.',
    );
    equal('nothing was handed to that helper', deliveriesFrom(session, areaUrl), []);
    equal('the area note is kept', view.notes.length, 1);
    await page.shot('attempt-legacy-helper');

    const shotUrl = ctx.origin + '/shop.html?legacy=shot';
    session.host.set({
      targets: [conversation],
      capabilities: {ok: false, error: 'Unknown request.'},
      send: {ok: true, keepNotes: true},
    });
    page = await session.open(shotUrl);
    await page.open();
    await addNote(page, 'title', 'Element note for a helper from before screenshots');
    equal(
      'the note was stored with its screenshot',
      isJpeg((await session.stored(notesKey(shotUrl)))[0].image),
      true,
    );
    await review(page, next => control(next, 'send')?.disabled === false);
    view = await sendNotes(page, 'unconfirmed');
    const request = deliveriesFrom(session, shotUrl)[0];
    equal(
      'a helper that predates screenshots gets the note without one',
      Object.hasOwn(request.notes[0], 'image'),
      false,
    );
    includes(
      'and the user is told screenshots were left out',
      view.attempt.text,
      'Screenshots were left out.',
    );
    equal(
      'keepNotes from an old helper reads as posted without a receipt',
      view.attempt.status,
      'unconfirmed',
    );

    // Helpers from before the `uncertain` flag reported a paste that had already landed as a plain
    // failure.
    const refusedUrl = ctx.origin + '/shop.html?legacy=refused';
    session.host.set({
      targets: [conversation],
      send: {ok: false, error: 'The pane did not accept the paste.'},
    });
    page = await session.open(refusedUrl);
    await page.open();
    await addNote(page, 'title', 'Note an old helper refuses');
    await review(page, next => control(next, 'send')?.disabled === false);
    view = await sendNotes(page, 'unknown');
    includes(
      'a refusal that does not rule out delivery reads as unknown',
      view.attempt.title,
      'No result recorded for Codex · site',
    );
    includes(
      'and shows what the helper said',
      view.attempt.text,
      'The pane did not accept the paste.',
    );
    equal(
      'its note is kept and cannot go out with a plain Send',
      [view.notes.length, control(view, 'send')?.disabled],
      [1, true],
    );
  });
}

// Two trusted presses on Send before the first has finished.
async function doubleActivation(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation], send: receipts.unconfirmed.reply, delay: 900});
    const clickUrl = ctx.origin + '/shop.html?double=click';
    const page = await session.open(clickUrl);
    await page.open();
    await addNote(page, 'title', 'Double click note');
    let view = await review(page, next => control(next, 'send')?.disabled === false);
    const send = control(view, 'send');
    const x = send.x + send.width / 2;
    const y = send.y + send.height / 2;
    await page.move(x, y);
    for (let press = 0; press < 2; press++) {
      await page.down(x, y);
      await page.up(x, y);
    }
    view = await settled(page, next => next.attempt?.status === 'unconfirmed');
    await delay(1500);
    equal('two rapid clicks on Send deliver once', deliveriesFrom(session, clickUrl).length, 1);

    for (const [name, reply] of [
      ['unconfirmed', receipts.unconfirmed.reply],
      ['submitted', receipts.submitted.reply],
    ]) {
      session.host.set({targets: [conversation], send: reply, delay: 900});
      const url = ctx.origin + '/shop.html?double=tabs-' + name;
      const first = await session.open(url);
      await first.open();
      await addNote(first, 'title', 'Two tabs note');
      await review(first, next => control(next, 'send')?.disabled === false);
      const second = await session.open(url);
      await openReview(second, next => control(next, 'send')?.disabled === false);
      await first.press('send');
      await second.press('send');
      await settled(first, next => next.attempt?.status === name);
      const late = await settled(
        second,
        next => next.status !== 'Sending notes…' && (next.attempt || next.status),
      );
      await delay(1500);
      equal(
        'Send in two tabs on one URL delivers once (' + name + ')',
        deliveriesFrom(session, url).length,
        1,
      );
      await second.shot('double-tabs-' + name);
      if (name === 'unconfirmed') {
        includes(
          'the second tab is told where and when the batch went',
          late.status,
          'Nitpost tried to send 1 note from this page to Codex · site',
        );
      } else {
        equal(
          'the second tab shows the first tab’s result and no notes',
          [late.attempt?.status, late.notes.length],
          ['submitted', 0],
        );
      }
    }
  });
}

// Reveals a saved note's card actions, which appear while the pointer is on the note.
async function hoverNote(page, index) {
  const view = await page.view();
  const pin = view.notes[index].pin;
  await page.move(pin.x + pin.width / 2, pin.y + pin.height / 2);
}

async function screenshotChoice(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?shots=1';
    const page = await session.open(url);
    await page.open();
    await page.clickPage('title');
    let view = await page.when('the note editor', next => next.editor?.tiles[0]?.painted);
    equal(
      'the screenshot preview appears before the note is saved',
      [view.editor.tiles[0].image, view.editor.tiles[0].state, view.editor.tiles[0].name],
      ['current', 'shown', 'Page now'],
    );
    equal(
      'nothing is stored while the preview is shown',
      await session.stored(notesKey(url)),
      undefined,
    );
    await page.shot('screenshot-preview');
    await page.press('omit-screenshot');
    view = await page.when(
      'the screenshot to be left out',
      next => next.editor.tiles[0].state === 'omitted',
    );
    includes('the tile says the screenshot is left out', view.editor.text, 'Left out of this note');
    equal('the choice can be undone', view.editor.tiles[0].action, 'Put back');
    await page.clickOverlay('.editor textarea');
    await page.type('Leave the picture out');
    await page.press('save');
    await page.when(
      'the note to be saved',
      next => next.mode === 'pick' && next.notes.length === 1,
    );
    let stored = await session.stored(notesKey(url));
    equal('a left-out screenshot is not stored at all', Object.hasOwn(stored[0], 'image'), false);

    await addNote(page, 'buy', 'Keep the picture for now');
    stored = await session.stored(notesKey(url));
    check('a kept screenshot is stored as a JPEG', isJpeg(stored[1].image));
    view = await review(page, next => control(next, 'send')?.disabled === false);
    equal(
      'only the second card says it has a screenshot',
      view.notes.map(note => note.meta),
      [null, 'Page now'],
    );
    await hoverNote(page, 1);
    await page.press('images');
    view = await page.when('the card’s images', next =>
      next.cardTiles.some(tile => tile.state === 'shown'),
    );
    equal(
      'review shows the saved screenshot under its name',
      view.cardTiles.map(tile => [tile.image, tile.state, tile.name]),
      [['current', 'shown', 'Page now']],
    );
    await page.press('remove-current');
    view = await settled(page, next => next.status.includes('removed'));
    const removal = '“Page now” image removed from note 2.';
    includes('review confirms the removal', view.status, removal);
    stored = await session.stored(notesKey(url));
    equal(
      'removing it in review deletes it from storage',
      stored.map(note => Object.hasOwn(note, 'image')),
      [false, false],
    );
    await sendNotes(page, 'submitted');
    const request = deliveriesFrom(session, url)[0];
    equal(
      'the helper received both notes without an image',
      request.notes.map(note => [note.comment, Object.hasOwn(note, 'image')]),
      [
        ['Leave the picture out', false],
        ['Keep the picture for now', false],
      ],
    );
    check(
      'nothing image-shaped is in the request',
      !JSON.stringify(request).includes('data:image'),
    );
  });
}

const customerEmail = 'dana.reyes@customer.example';

// Removes the page text from a note that was saved with it.
async function removeSavedExcerpt(page, index) {
  await page.clickOverlay('.note .pin', {index});
  let view = await page.when('the note editor', next => next.editor?.excerpt === 'shown');
  equal(
    'a saved note offers to remove its page text',
    control(view, 'omit-excerpt')?.text,
    'Remove',
  );
  await page.press('omit-excerpt');
  view = await page.when('the text to be left out', next => next.editor.excerpt === 'omitted');
  check(
    'the editor no longer shows the address',
    !view.editor.text.includes(customerEmail),
    view.editor.text,
  );
  await page.press('save');
  return settled(page, next => !next.editor);
}

async function privacyOmit(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/account.html';
    const page = await session.open(url);
    await page.open();
    await page.clickPage('billing');
    let view = await page.when('the note editor', next => next.editor?.tiles[0]?.painted);
    equal('the panel with the address is what was picked', view.editor.context, '#billing');
    equal(
      'its screenshot and its page text are shown before anything is saved',
      [view.editor.tiles[0].state, view.editor.excerpt, view.editor.text.includes(customerEmail)],
      ['shown', 'shown', true],
    );
    equal('the page text can be left out', control(view, 'omit-excerpt')?.text, 'Leave out');
    await page.shot('privacy-preview');
    await writeNote(page, 'Tighten the spacing in this panel', {omit: true, omitText: true});
    await page.clickPage('billing');
    await writeNote(page, 'Align the labels in this panel', {omit: true});
    let stored = await session.stored(notesKey(url));
    equal('a note saved with its page text left out stores none', stored[0].text, '');
    check(
      'a note saved with its page text has the address',
      stored[1].text.includes(customerEmail),
      stored[1].text,
    );
    await review(page, next => control(next, 'send')?.disabled === false);
    await removeSavedExcerpt(page, 1);
    stored = await session.stored(notesKey(url));
    equal(
      'Remove on the saved note clears its stored text',
      stored.map(note => note.text),
      ['', ''],
    );
    check(
      'nothing stored holds the address or an image',
      !JSON.stringify(await session.stored()).includes(customerEmail) &&
        !JSON.stringify(await session.stored()).includes('data:image'),
    );

    await page.press('copy');
    await page.when('the copy to be reported', next => next.status.includes('Copied'));
    const copied = await clipboard(page);
    check(
      'Copy for agent carries the notes without the address',
      copied.includes('Tighten the spacing in this panel') && !copied.includes(customerEmail),
      copied,
    );
    view = await sendNotes(page, 'submitted');
    const request = deliveriesFrom(session, url)[0];
    const sent = JSON.stringify(request);
    equal(
      'the helper received both notes with no image and no page text',
      request.notes.map(note => [note.selector, note.text, Object.hasOwn(note, 'image')]),
      [
        ['#billing', '', false],
        ['#billing', '', false],
      ],
    );
    check(
      'nothing image-shaped left the page',
      !sent.includes('data:image') && !sent.includes('/9j/'),
    );
    check('the address did not leave the page', !sent.includes(customerEmail), sent);
  });
}

async function attachFile(page, file) {
  await page.send('Page.setInterceptFileChooserDialog', {enabled: true});
  const from = page.events.length;
  await page.press('add-reference');
  const opened = await until('the file chooser to open', () =>
    page.events.slice(from).find(event => event.method === 'Page.fileChooserOpened'),
  );
  await page.send('DOM.setFileInputFiles', {
    files: [file],
    backendNodeId: opened.params.backendNodeId,
  });
  await page.send('Page.setInterceptFileChooserDialog', {enabled: false});
}

async function copyImage(page, bytes) {
  await page.eval(
    '(async () => { const bytes = Uint8Array.from(atob("' +
      bytes.toString('base64') +
      '"), char => char.charCodeAt(0)); const blob = new Blob([bytes], {type: "image/png"});' +
      'await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]); })()',
  );
}

const tileNames = tiles => tiles.map(tile => [tile.image, tile.state, tile.name, tile.label]);
const bothTiles = [
  ['current', 'shown', 'Page now', 'Screenshot of the page as it is now'],
  ['reference', 'shown', 'Wanted result', 'Reference image of the wanted result'],
];

async function referenceImage(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?reference=1';
    const chosen = [200, 30, 90];
    const pasted = [30, 160, 90];
    const file = path.join(session.home, 'wanted.png');
    fs.writeFileSync(file, png(240, 160, chosen));
    const page = await session.open(url);
    await page.open();
    await addReferences(page, file, png(200, 120, pasted));

    const stored = await session.stored(notesKey(url));
    check(
      'both notes store a screenshot and a reference as separate JPEGs',
      stored.every(
        note => isJpeg(note.image) && isJpeg(note.reference) && note.image !== note.reference,
      ),
    );
    let view = await review(page, next => control(next, 'send')?.disabled === false);
    equal(
      'review labels both images on each card',
      view.notes.map(note => note.meta),
      Array(2).fill('Page now + Wanted result'),
    );
    await hoverNote(page, 0);
    await page.press('images');
    view = await page.when(
      'the card’s images',
      next => next.cardTiles.filter(tile => tile.state === 'shown').length === 2,
    );
    equal(
      'review shows them under different names',
      view.cardTiles.map(tile => [tile.image, tile.name]),
      [
        ['current', 'Page now'],
        ['reference', 'Wanted result'],
      ],
    );
    await page.shot('reference-review');
    await sendNotes(page, 'submitted');
    const notes = deliveriesFrom(session, url)[0].notes;
    equal(
      'the helper received the comments',
      notes.map(note => note.comment),
      ['Make the button look like this', 'pasted words, and the heading like this'],
    );
    check(
      'the helper received image and reference as separate fields',
      notes.every(
        note => isJpeg(note.image) && isJpeg(note.reference) && note.image !== note.reference,
      ),
    );
    const colours = [];
    for (const note of notes) colours.push((await imageInfo(page, note.reference)).corner);
    check(
      'each reference is the picture the user supplied',
      near(colours[0], chosen) && near(colours[1], pasted),
      JSON.stringify(colours),
    );
    const shot = await imageInfo(page, notes[0].image);
    const button = await page.rect('buy');
    equal(
      'the screenshot is the crop of the picked element',
      [shot.width, shot.height],
      [Math.round(button.width), Math.round(button.height)],
    );
  });
}

// One note with a reference from the file chooser, one with a pasted image and pasted text.
async function addReferences(page, file, pastedPng) {
  await page.clickPage('buy');
  await page.when('the note editor', next => next.editor);
  await attachFile(page, file);
  let view = await page.when(
    'the chosen file to appear',
    next => next.editor.tiles[1]?.state === 'shown',
  );
  equal(
    'a chosen file is shown beside the screenshot, each under its own name',
    tileNames(view.editor.tiles),
    bothTiles,
  );
  await page.shot('reference-editor');
  await writeNote(page, 'Make the button look like this');

  await page.clickPage('title');
  await page.when('the note editor', next => next.editor);
  await copyImage(page, pastedPng);
  await page.clickOverlay('.editor textarea');
  await page.paste();
  view = await page.when(
    'the pasted image to appear',
    next => next.editor.tiles[1]?.state === 'shown',
  );
  equal('a pasted image becomes the reference', tileNames(view.editor.tiles), bothTiles);
  equal('pasting an image leaves the comment empty', view.editor.comment, '');
  await page.eval('navigator.clipboard.writeText("pasted words")');
  await page.paste();
  view = await page.when('the pasted text', next => next.editor.comment !== '');
  equal('pasting text still goes into the comment', view.editor.comment, 'pasted words');
  equal('and leaves the reference in place', view.editor.tiles[1].state, 'shown');
  await writeNote(page, ', and the heading like this');
}

const firstArea = {x: 950, y: 300, width: 200, height: 120};
const secondArea = {x: 960, y: 650, width: 150, height: 110};

// One area by dragging, then one by two clicks after the page has scrolled.
async function markTwoAreas(page) {
  await page.press('pick-area');
  await page.when('area picking', view => view.pick === 'area');
  await page.drag(950, 300, 1150, 420);
  let view = await page.when('the note editor', next => next.editor);
  equal(
    'dragging over empty space opens an area note',
    [view.editor.scope, view.editor.context],
    ['area', 'area 200 × 120 at 950, 300'],
  );
  includes(
    'the editor says no element is attached',
    view.editor.text,
    'No element is attached to it.',
  );
  await page.shot('area-editor');
  await writeNote(page, 'Too much empty space here');

  await page.eval('window.scrollTo(0, 200)');
  await page.press('pick-area');
  await page.click(960, 450);
  view = await page.when('the first corner', next => next.lead === 'Now click the opposite corner');
  await page.click(1110, 560);
  view = await page.when('the note editor', next => next.editor);
  equal(
    'two clicks mark an area in document coordinates',
    [view.editor.scope, view.editor.context],
    ['area', 'area 150 × 110 at 960, 650'],
  );
  await writeNote(page, 'Second area, by two clicks');
}

async function areaNotes(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?area=1';
    const page = await session.open(url);
    await page.open();
    await markTwoAreas(page);

    const stored = await session.stored(notesKey(url));
    equal(
      'stored notes have the area scope and rect',
      stored.map(note => [note.scope, note.rect]),
      [
        ['area', firstArea],
        ['area', secondArea],
      ],
    );
    const fields = stored.map(({image, ...note}) => note);
    check(
      'no selector, excerpt or element list is stored for an area',
      fields.every(
        note => !['selector', 'text', 'elements'].some(key => Object.hasOwn(note, key)),
      ) && !JSON.stringify(fields).includes('selector'),
      JSON.stringify(fields),
    );
    check(
      'each area has a screenshot of the region',
      stored.every(note => isJpeg(note.image)),
    );

    let view = await review(page, next => control(next, 'send')?.disabled === false);
    equal(
      'review marks both notes as areas',
      view.notes.map(note => note.scope),
      ['area', 'area'],
    );
    const before = view.notes.map(note => Math.round(note.pin.y));
    await page.eval('window.scrollBy(0, 60)');
    await delay(200);
    view = await page.view();
    equal(
      'each pin follows the page when it scrolls',
      view.notes.map(note => Math.round(note.pin.y)),
      before.map(y => y - 60),
    );
    await hoverNote(page, 1);
    view = await page.when('the area outline', next => next.outline);
    equal(
      'hovering a note outlines its area',
      [view.outline.tag, Math.round(view.outline.width), Math.round(view.outline.height)],
      ['area', 150, 110],
    );
    await page.shot('area-review');

    await sendNotes(page, 'submitted');
    const notes = deliveriesFrom(session, url)[0].notes;
    equal(
      'the helper received the scope and rect',
      notes.map(note => [note.scope, note.rect]),
      [
        ['area', firstArea],
        ['area', secondArea],
      ],
    );
    check(
      'the helper received no selector for an area',
      !JSON.stringify(notes.map(({image, ...note}) => note)).includes('selector') &&
        notes.every(note => !Object.hasOwn(note, 'selector') && !Object.hasOwn(note, 'text')),
    );
    const crop = await imageInfo(page, notes[0].image);
    equal('the screenshot is the region that was marked', [crop.width, crop.height], [200, 120]);
  });
}

const swatches = ids =>
  ids.map(id => ({selector: '#' + id, text: id[0].toUpperCase() + id.slice(1)}));

async function groupNotes(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?group=1';
    const page = await session.open(url);
    await page.open();
    await page.press('pick-group');
    for (const id of ['oak', 'walnut', 'ash']) await page.clickPage(id);
    let view = await page.when('three marked elements', next => next.marks === 3);
    equal(
      'the toggle collects elements and counts them',
      [view.pick, view.lead],
      ['group', '3 of 8 selected'],
    );
    await page.shot('group-picking');
    await page.press('group-done');
    view = await page.when('the note editor', next => next.editor);
    equal('one editor opens for the three elements', view.editor.scope, 'group');
    includes('and lists them', view.editor.text, 'One note for these 3 elements.');
    await writeNote(page, 'Make these three the same height');

    equal('picking starts again on single elements', (await page.view()).pick, 'element');
    for (const id of ['oak', 'ash', 'beech']) await page.clickPage(id, SHIFT);
    view = await page.when('three marked elements', next => next.marks === 3);
    equal('Shift+click collects a group without the toggle', view.pick, 'group');
    await page.press('group-done');
    await writeNote(page, 'Why do these differ?', {kind: 'question'});

    const expected = [swatches(['oak', 'walnut', 'ash']), swatches(['oak', 'ash', 'beech'])];
    const stored = await session.stored(notesKey(url));
    equal(
      'stored notes list their elements',
      stored.map(note => [note.scope, note.elements]),
      expected.map(elements => ['group', elements]),
    );
    check(
      'a group stores no single selector or rect',
      stored.every(note => !['selector', 'text', 'rect'].some(key => Object.hasOwn(note, key))),
    );
    view = await review(page, next => control(next, 'send')?.disabled === false);
    check(
      'review counts the elements on each card',
      view.notes.every(note => note.scope === 'group' && note.meta.includes('3 elements')) &&
        view.notes[1].meta.startsWith('Question'),
      JSON.stringify(view.notes),
    );
    await sendNotes(page, 'submitted');
    const notes = deliveriesFrom(session, url)[0].notes;
    equal(
      'the helper received each group',
      notes.map(note => [note.scope, note.kind, note.elements]),
      [
        ['group', 'change', expected[0]],
        ['group', 'question', expected[1]],
      ],
    );
  });
}

// The flat colour each fixture menu paints its items in. A crop of that colour was taken while the
// menu was open.
const menuColours = {
  account: [10, 125, 50],
  shop: [20, 60, 200],
  filters: [120, 40, 160],
  shipping: [200, 90, 10],
  dialog: [190, 20, 40],
};

const menuOpen = {
  account: '!document.getElementById("account-list").hidden',
  filters: 'document.getElementById("filters").matches(":popover-open")',
  shipping: 'document.getElementById("shipping").open',
  shop: 'getComputedStyle(document.querySelector("#shop-menu ul")).display === "block"',
  dialog: 'document.getElementById("dialog").open',
};

// Saves the note in the open editor and decodes the crop that was stored with it.
async function savedCrop(session, page, url) {
  await writeNote(page, 'A note about this menu item');
  const note = (await session.stored(notesKey(url))).at(-1);
  return note.image ? imageInfo(page, note.image) : {width: 0, height: 0, corner: null};
}

// Opens a menu with its trigger, activates Nitpost and picks one item inside the menu.
async function pickInMenu(session, ctx, menu, how) {
  const url = ctx.origin + '/shop.html?menu=' + menu.name + '-' + how;
  const label = menu.name + ' menu, ' + how + ': ';
  const page = await session.open(url);
  await page.clickPage(menu.trigger);
  equal(label + 'the page’s own click opens it', await page.eval(menuOpen[menu.name]), true);
  await page.open();
  equal(label + 'it is still open after activation', await page.eval(menuOpen[menu.name]), true);
  const item = how === 'pointer' ? menu.pointerItem : menu.keyItem;
  if (how === 'pointer') {
    await page.clickPage(item);
  } else {
    await page.key('Tab');
    equal(
      label + 'Tab moves into the open menu',
      await page.eval('document.activeElement.id'),
      item,
    );
    equal(label + 'it is still open with focus inside', await page.eval(menuOpen[menu.name]), true);
    await page.key('Enter');
  }
  const view = await page.when('the note editor', next => next.editor);
  equal(label + 'the item inside it is picked', view.editor.context, '#' + item);
  await page.shot('menu-' + menu.name + '-' + how);
  const log = await page.eval('menuLog');
  check(
    label + 'the page did not receive the pick as a click',
    !log.includes('click:' + item),
    log.join(', '),
  );
  equal(label + 'the page did not navigate', await page.eval('location.href'), url);
  const crop = await savedCrop(session, page, url);
  const box = await page.eval(menuOpen[menu.name]).then(open => (open ? page.rect(item) : null));
  check(label + 'the crop is not empty', crop.width > 8 && crop.height > 8, JSON.stringify(crop));
  if (menu.flat || how === 'pointer') {
    check(
      label + 'the menu was open when the crop was taken',
      near(crop.corner, menuColours[menu.name]),
      'corner colour ' +
        JSON.stringify(crop.corner) +
        ', expected about ' +
        JSON.stringify(menuColours[menu.name]),
    );
  }
  observe(
    label +
      'after the note was saved the menu is ' +
      (box ? 'still open' : 'closed') +
      '; page log: ' +
      (log.join(', ') || 'empty'),
  );
}

const pickableMenus = [
  {
    name: 'account',
    trigger: 'account-trigger',
    pointerItem: 'account-signout',
    keyItem: 'account-profile',
    flat: true,
  },
  {
    name: 'filters',
    trigger: 'filters-trigger',
    pointerItem: 'filter-colour',
    keyItem: 'filter-price',
    flat: true,
  },
  {
    name: 'shipping',
    trigger: 'shipping-summary',
    pointerItem: 'shipping-terms',
    keyItem: 'returns-link',
    flat: false,
  },
];

async function hoverMenu(session, ctx) {
  const url = ctx.origin + '/shop.html?menu=hover';
  const page = await session.open(url);
  const trigger = await page.rect('shop-trigger');
  await page.move(trigger.cx, trigger.cy);
  const steps = ['open on hover: ' + (await page.eval(menuOpen.shop))];
  await page.open();
  steps.push(
    'open after activation without moving the pointer: ' +
      (await page.eval(menuOpen.shop)) +
      ' (shield lets the pointer through: ' +
      (await page.view()).pass +
      ')',
  );
  const item = await page.rect('shop-lamps');
  await page.move(item.cx, item.cy);
  steps.push('open with the pointer on an item: ' + (await page.eval(menuOpen.shop)));
  await page.down(item.cx, item.cy);
  await page.up(item.cx, item.cy);
  const view = await page.when('the note editor', next => next.editor, 4000).catch(() => null);
  steps.push('item picked: ' + (view ? view.editor.context : 'no editor opened'));
  await page.shot('menu-hover');
  if (view) {
    const crop = await savedCrop(session, page, url);
    steps.push(
      'crop ' +
        crop.width +
        ' × ' +
        crop.height +
        ', taken while open: ' +
        near(crop.corner, menuColours.shop),
    );
  }
  steps.push('page clicks: ' + ((await page.eval('menuLog')).join(', ') || 'none'));
  observe('hover-only CSS menu: ' + steps.join('; '));
}

async function modalDialog(session, ctx) {
  const url = ctx.origin + '/shop.html?menu=dialog';
  const page = await session.open(url);
  await page.clickPage('dialog-trigger');
  await page.activate();
  let view = await page
    .when('the overlay', next => next.mode !== 'idle' && next.status !== '', 4000)
    .catch(() => page.view());
  const steps = [
    'dialog open after activation: ' + (await page.eval(menuOpen.dialog)),
    'status: ' + JSON.stringify(view?.status ?? null),
  ];
  await page.clickPage('confirm');
  view = await page.when('the note editor', next => next.editor, 4000).catch(() => null);
  steps.push(
    'click on a button in the dialog: ' +
      (view ? 'editor for ' + view.editor.context : 'no editor opened'),
    'status: ' + JSON.stringify((await page.view())?.status ?? null),
    'dialog still open: ' + (await page.eval(menuOpen.dialog)),
  );
  await page.shot('menu-dialog');
  if (view) {
    await page.type('typed while the dialog is open');
    steps.push(
      'typing while the dialog is open reaches the comment: ' +
        ((await page.view()).editor.comment !== ''),
    );
    await page.key('Escape');
    await delay(400);
    view = await page.view();
    steps.push(
      'after Escape: dialog open ' +
        (await page.eval(menuOpen.dialog)) +
        ', editor open ' +
        Boolean(view?.editor),
    );
    if (view?.editor) {
      const crop = await savedCrop(session, page, url);
      steps.push(
        'note saved after the dialog closed, crop ' +
          crop.width +
          ' × ' +
          crop.height +
          ', taken while the dialog was open: ' +
          near(crop.corner, menuColours.dialog),
      );
    }
  }
  steps.push('page clicks: ' + ((await page.eval('menuLog')).join(', ') || 'none'));
  observe('modal <dialog>: ' + steps.join('; '));
}

async function nativeSelect(session, ctx) {
  const page = await session.open(ctx.origin + '/shop.html?menu=select');
  await page.clickPage('sort');
  await delay(300);
  await page.activate();
  const view = await page.when('the overlay', next => next.mode !== 'idle', 4000).catch(() => null);
  observe(
    'native <select>: its list is drawn by the operating system, outside the page, and headless ' +
      'Chrome does not open one, so whether it survives activation needs a person. Here the ' +
      'overlay ' +
      (view ? 'opened in ' + view.mode + ' mode' : 'did not open') +
      ' with the select focused (' +
      (await page.eval('document.activeElement.id')) +
      ') and its value unchanged (' +
      (await page.eval('sort.value')) +
      ').',
  );
}

async function shortcut(session, ctx) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const suggested = manifest.commands?._execute_action?.suggested_key?.default;
  check(
    'the manifest declares the action command with a suggested key',
    Boolean(suggested),
    JSON.stringify(manifest.commands),
  );
  const commands = await session.worker('chrome.commands.getAll()');
  const assigned = commands.find(command => command.name === '_execute_action')?.shortcut ?? '';
  check(
    'Chrome reports a shortcut for _execute_action in this profile',
    assigned !== '',
    JSON.stringify(commands),
  );
  const page = await session.open(ctx.origin + '/shop.html?menu=shortcut');
  const view = await page.open();
  equal('the pick bar shows that shortcut', view.shortcut, assigned);
  await page.shot('shortcut-pick-bar');
  observe(
    'shortcut: manifest suggests ' +
      suggested +
      ', chrome.commands.getAll() reports ' +
      JSON.stringify(assigned) +
      '. A physical key press cannot be synthesized in headless Chrome: CDP key events go to the ' +
      'page, not to the browser’s command handling. Extensions.triggerAction runs the same ' +
      'action, without a click on the page.',
  );
}

async function transientMenus(ctx) {
  await withSession(ctx, {}, async session => {
    for (const menu of pickableMenus) {
      for (const how of ['pointer', 'keyboard']) await pickInMenu(session, ctx, menu, how);
    }
    await hoverMenu(session, ctx);
    await modalDialog(session, ctx);
    await nativeSelect(session, ctx);
    await shortcut(session, ctx);
  });
}

// Notes and destinations the way 0.3.0-beta.1 and beta.2 wrote them: no `scope`, beta.1 without
// `kind` or `image`, and the destination under `destination:<site>` or, older still,
// `target:<origin>`.
// Stores a beta.1 note and a beta.2 note for `url` and returns the beta.2 note's screenshot.
async function seedEarlierNotes(session, page, url) {
  const image = await page.eval(
    '(() => { const canvas = document.createElement("canvas"); canvas.width = 320;' +
      'canvas.height = 200; const context = canvas.getContext("2d");' +
      'context.fillStyle = "#1a56db"; context.fillRect(0, 0, 320, 200);' +
      'return canvas.toDataURL("image/jpeg", 0.8); })()',
  );
  const beta1 = {
    id: 'beta1-note',
    selector: '#title',
    text: 'Lounge chair',
    comment: 'Keep this heading',
    width: 900,
    height: 700,
  };
  const beta2 = {
    id: 'beta2-note',
    kind: 'question',
    selector: '#buy',
    text: 'Add to cart',
    comment: 'Why is this blue?',
    width: 1280,
    height: 800,
    image,
  };
  await session.seed({[notesKey(url)]: [beta1, beta2]});
  return image;
}

async function reviewEarlierNotes(session, page, url, label) {
  let view = await openReview(page, next => control(next, 'send')?.disabled === false);
  equal(
    label + 'both earlier notes render as element notes',
    view.notes.map(note => [note.scope, note.comment, note.lost]),
    [
      ['element', 'Keep this heading', false],
      ['element', 'Why is this blue?', false],
    ],
  );
  check(
    label + 'the beta.2 note keeps its kind and screenshot label',
    view.notes[1].meta.startsWith('Question') && view.notes[1].meta.includes('Page now'),
    view.notes[1].meta,
  );
  equal(label + 'the remembered conversation is selected', view.target.value, conversation.block);

  await hoverNote(page, 1);
  await page.press('images');
  view = await page.when('the stored screenshot', next =>
    next.cardTiles.some(tile => tile.state === 'shown'),
  );
  equal(
    label + 'the stored screenshot opens in review',
    view.cardTiles.map(tile => tile.image),
    ['current'],
  );

  await page.clickOverlay('.note .pin', {index: 0});
  view = await page.when('the note editor', next => next.editor);
  equal(
    label + 'an earlier note opens for editing',
    [view.editor.context, view.editor.comment],
    ['#title', 'Keep this heading'],
  );
  await page.clickOverlay('.editor textarea');
  await page.key('ArrowDown', {modifiers: META});
  await page.type(', as it is');
  await page.press('save');
  view = await settled(page, next => next.notes[0]?.comment === 'Keep this heading, as it is');
  equal(
    label + 'the edit is stored',
    (await session.stored(notesKey(url)))[0].comment,
    'Keep this heading, as it is',
  );
}

async function migrateFrom(ctx, origin, destinationKey, destination) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = origin + '/shop.html?migrated=1';
    const label = destinationKey.split(':')[0] + ' key: ';
    const page = await session.open(url);
    const image = await seedEarlierNotes(session, page, url);
    await session.seed({[destinationKey]: destination});
    await reviewEarlierNotes(session, page, url, label);

    await page.press('copy');
    await page.when('the copy to be reported', next => next.status.includes('Copied'));
    const text = await clipboard(page);
    includes(
      label + 'the copy has the beta.1 note',
      text,
      '## 1. Change request\n\nKeep this heading, as it is\n\n- Element: `#title`',
    );
    includes(
      label + 'the copy has the beta.2 note',
      text,
      '## 2. Question\n\nWhy is this blue?\n\n- Element: `#buy`',
    );

    const view = await sendNotes(page, 'submitted');
    const request = deliveriesFrom(session, url)[0];
    equal(
      label + 'the send goes to the remembered conversation',
      [request.session, request.block],
      [conversation.session, conversation.block],
    );
    equal(
      label + 'the helper received both notes',
      request.notes.map(note => [note.kind, note.selector, note.comment]),
      [
        ['change', '#title', 'Keep this heading, as it is'],
        ['question', '#buy', 'Why is this blue?'],
      ],
    );
    equal(
      label + 'the beta.2 screenshot went with its note',
      [request.notes[0].image, request.notes[1].image],
      [undefined, image],
    );
    equal(label + 'sent notes are cleared', view.notes.length, 0);
  });
}

async function dataMigration(ctx) {
  await migrateFrom(ctx, ctx.origin, 'destination:' + ctx.origin, {
    project: conversation.project,
    target: conversation,
  });
  // The oldest versions remembered the pane alone, without its project folder.
  const {project, ...pane} = conversation;
  await migrateFrom(ctx, ctx.secondOrigin, 'target:' + ctx.secondOrigin, pane);
}

async function closedOverlay(page) {
  await until('the overlay to close', async () => (await page.view()) === null);
}

// A full navigation, a pushState route and a hash route each start empty. `at` names a URL.
async function notesStayOnTheirUrl(page, at) {
  await page.goto(at('b'));
  let view = await page.open();
  equal(
    'URL B starts with no notes from URL A',
    [view.mode, view.notes.length, control(view, 'review')],
    ['pick', 0, null],
  );

  await page.goto(at('a'));
  view = await openReview(page);
  equal(
    'URL A still has its note',
    view.notes.map(note => note.comment),
    ['Only on page A'],
  );
  await page.eval('history.pushState({}, "", "/shop.html?page=spa")');
  await closedOverlay(page);
  view = await page.open();
  equal('a pushState route starts with no notes', [view.mode, view.notes.length], ['pick', 0]);
  await page.eval('location.hash = "#details"');
  await closedOverlay(page);
  view = await page.open();
  equal('a hash route starts with no notes', [view.mode, view.notes.length], ['pick', 0]);
  await page.eval('history.go(-2)');
  await until('the first route', async () => (await page.eval('location.href')) === at('a'));
  await closedOverlay(page);
  view = await openReview(page, next => control(next, 'send')?.disabled === false);
  equal(
    'going back shows the first route’s note again',
    view.notes.map(note => note.comment),
    ['Only on page A'],
  );
}

async function attemptStaysOnItsUrl(session, page, at) {
  await sendNotes(page, 'unconfirmed');
  await page.goto(at('b'));
  await page.open();
  await addNote(page, 'title', 'Only on page B');
  const view = await review(page, next => control(next, 'send') !== null);
  equal(
    'an attempt on URL A does not show on URL B',
    [view.attempt, view.notes.map(note => note.attempt)],
    [null, [null]],
  );
  equal('and does not block Send on URL B', control(view, 'send').disabled, false);
  equal('URL B has no attempt record', await session.stored(attemptKey(at('b'))), undefined);
  await page.shot('isolation-url-b');
}

// A send whose reply arrives after the tab has moved to another route.
async function lateReply(session, page, at) {
  session.host.set({targets: [conversation], send: receipts.submitted.reply, delay: 1500});
  await page.goto(at('c'));
  await page.open();
  await addNote(page, 'title', 'Sent just before navigating');
  await review(page, next => control(next, 'send')?.disabled === false);
  await page.press('send');
  await page.eval('history.pushState({}, "", "/shop.html?page=d")');
  await until(
    'the slow send to reach the helper',
    () => deliveriesFrom(session, at('c')).length === 1,
  );
  await until(
    'the slow reply to be recorded',
    async () => (await session.stored(attemptKey(at('c'))))?.status === 'submitted',
  );
  await delay(500);
  equal(
    'the overlay closed on navigation and the late reply did not reopen it',
    await page.view(),
    null,
  );
  let view = await page.open();
  equal(
    'the new route is clean after the late reply',
    [view.mode, view.notes.length, control(view, 'review'), view.status],
    ['pick', 0, null, ''],
  );
  equal(
    'nothing was stored under the new route',
    [await session.stored(notesKey(at('d'))), await session.stored(attemptKey(at('d')))],
    [undefined, undefined],
  );
  equal(
    'the sent note was cleared from the route it was sent from',
    await session.stored(notesKey(at('c'))),
    undefined,
  );
  await page.eval('history.back()');
  await until(
    'the route the send came from',
    async () => (await page.eval('location.href')) === at('c'),
  );
  await closedOverlay(page);
  view = await page.open();
  equal(
    'back on that route the picker offers the last send',
    control(view, 'review')?.text,
    'Last send',
  );
  await page.press('review');
  view = await page.when('the last send', next => next.mode === 'review' && next.attempt);
  const entered = view.attempt.title.startsWith('Entered in Codex · site');
  check(
    'and its record is correct',
    view.attempt.status === 'submitted' && entered,
    JSON.stringify(view.attempt),
  );
  equal('the slow send was delivered once', deliveriesFrom(session, at('c')).length, 1);
}

async function isolation(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation], send: receipts.unconfirmed.reply});
    const at = name => ctx.origin + '/shop.html?page=' + name;
    const page = await session.open(at('a'));
    await page.open();
    await addNote(page, 'title', 'Only on page A');
    await notesStayOnTheirUrl(page, at);
    await attemptStaysOnItsUrl(session, page, at);
    await lateReply(session, page, at);
  });
}

async function offline(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?offline=1';
    const page = await session.open(url);
    await page.send('Network.enable');
    const network = down =>
      page.send('Network.emulateNetworkConditions', {
        offline: down,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    await network(true);
    equal(
      'the page is offline',
      [
        await page.eval('navigator.onLine'),
        await page.eval('fetch(location.href).then(() => "reached", () => "unreachable")'),
      ],
      [false, 'unreachable'],
    );
    await page.open();
    await page.clickPage('title');
    let view = await page.when('the note editor', next => next.editor?.tiles[0]?.painted);
    equal('offline: the screenshot is captured and previewed', view.editor.tiles[0].state, 'shown');
    await writeNote(page, 'Written while offline');
    check(
      'offline: the note is saved with its screenshot',
      isJpeg((await session.stored(notesKey(url)))[0].image),
    );
    view = await review(page);
    equal(
      'offline: the local helper is still reported as connected, with its conversation',
      [view.connection, control(view, 'send')?.disabled],
      ['connected', false],
    );
    await page.press('copy');
    await page.when('the copy to be reported', next => next.status.includes('Copied'));
    includes('offline: Copy for agent works', await clipboard(page), 'Written while offline');
    await page.shot('offline-review');

    session.host.remove();
    let result = await recheck(page, session, 'missing');
    equal(
      'offline with the helper gone: the state says so and Send is unavailable',
      [result.view.facts.helper?.state, control(result.view, 'send')?.disabled],
      ['problem', true],
    );
    equal(
      'the draft is still there',
      result.view.notes.map(note => note.comment),
      ['Written while offline'],
    );

    await network(false);
    session.host.install();
    result = await recheck(page, session, 'connected');
    equal('back online, Check again recovers', control(result.view, 'send')?.disabled, false);
    equal('nothing was sent by checking', deliveriesFrom(session, url), []);
    await sendNotes(page, 'submitted');
    equal(
      'the offline note is delivered once',
      deliveriesFrom(session, url).map(request => request.notes[0].comment),
      ['Written while offline'],
    );
  });
}

// Presses Tab until the overlay control that `wanted` accepts has focus. Every overlay stop on the
// way is collected, so the caller can check that focus was never lost or invisible.
async function tabTo(page, wanted, stops = []) {
  for (let presses = 0; presses < 60; presses++) {
    await page.key('Tab');
    const focus = (await page.view())?.focus ?? null;
    if (focus) stops.push(focus);
    if (focus && wanted(focus)) return focus;
  }
  throw new Error(
    'Tab never reached the control. Stops: ' + stops.map(stop => stop.name).join(', '),
  );
}

async function tabToPage(page, id) {
  await until('keyboard focus on #' + id, async () => {
    await page.key('Tab');
    return (await page.eval('document.activeElement.id')) === id;
  });
}

// The lists are disabled while a choice is saved, which drops focus for a moment.
async function focused(page) {
  const view = await page.when('focus to settle', next => next.focus, 1500).catch(() => null);
  return view?.focus ?? null;
}

// The lists are disabled while a choice is saved. Chrome sometimes drops focus then, so this is
// recorded when it happens instead of failing one run in a few.
async function noteLostFocus(page, what) {
  if ((await focused(page)) === null) {
    observe(
      'keyboard focus left the bar after choosing ' +
        what +
        ' from its list; Tab still reaches Send.',
    );
  }
}

function checkStops(name, stops) {
  const poor = stops.filter(stop => !stop.name || !stop.visible || !stop.ring);
  check(
    name +
      ': every focus stop is a named control with a visible focus ring (' +
      stops.length +
      ' stops)',
    stops.length > 0 && poor.length === 0,
    JSON.stringify(poor),
  );
}

async function keyboardNote(ctx, session) {
  const url = ctx.origin + '/shop.html?keyboard=1';
  const page = await session.open(url);
  const stops = [];
  await page.open();
  await tabToPage(page, 'buy');
  let view = await page.view();
  equal('Tab marks the focused page element', view.outline?.tag, 'button#buy');
  const modes = [];
  for (let press = 0; press < 3; press++) {
    await page.key('m');
    modes.push((await page.view()).pick);
  }
  equal(
    'M cycles Element, Several, Area and back, and the bar shows the keys',
    [modes, ['keyboard-hint', 'mode-key'].map(name => control(view, name) !== null)],
    [
      ['group', 'area', 'element'],
      [true, true],
    ],
  );
  await page.key('Enter');
  view = await page.when('the note editor', next => next.editor);
  equal(
    'Enter opens the editor on that element, with focus in the comment',
    [view.editor.context, view.focus?.tag, view.focus?.name],
    ['#buy', 'textarea', 'Comment'],
  );
  stops.push(view.focus);
  await page.type('Make this button green');
  await page.key('Enter', {modifiers: META});
  await page.when('the note to be saved', next => next.mode === 'pick' && next.notes.length === 1);
  check(
    'Command+Enter saves the note',
    (await session.stored(notesKey(url)))?.[0]?.comment === 'Make this button green',
  );

  await tabTo(page, focus => focus.control === 'review', stops);
  await page.key('Enter');
  const opened = await page
    .when('the list', next => next.mode === 'review', 2500)
    .catch(() => null);
  check(
    'Enter on the focused Review button opens the list',
    opened !== null,
    'The button has focus and a trusted click fires at 0, 0, but the picker stays open.',
  );
  if (!opened) {
    await page.key(' ');
    const spaced = await page
      .when('the list', next => next.mode === 'review', 2500)
      .catch(() => null);
    check(
      'Space on the focused Review button opens the list',
      spaced !== null,
      'Nothing happens either.',
    );
    // Escape leaves the picker for the list when there are notes: the only keyboard way there.
    if (!spaced) await page.key('Escape');
  }
  view = await settled(page);
  equal('the list opens with focus on its first control', view.focus?.control, 'pick');
  await tabTo(page, focus => focus.id === 'nitpost-project', stops);
  await page.key('s');
  view = await page.when(
    'the project to be chosen',
    next => next.project.value === '/work/site' && !next.target.disabled,
  );
  await noteLostFocus(page, 'the project');
  await tabTo(page, focus => focus.id === 'nitpost-target', stops);
  await page.key('c');
  view = await page.when(
    'the conversation to be chosen',
    next => control(next, 'send')?.disabled === false,
  );
  await noteLostFocus(page, 'the conversation');
  await tabTo(page, focus => focus.control === 'send', stops);
  await page.shot('keyboard-focus-on-send');
  await page.key('Enter');
  view = await settled(page, next => next.attempt?.status === 'confirmed');
  equal(
    'the note was sent to the chosen conversation without the pointer',
    deliveriesFrom(session, url).map(request => [request.block, request.notes[0].comment]),
    [[conversation.block, 'Make this button green']],
  );
  check(
    'focus is on a control after the send',
    (await focused(page)) !== null,
    'Nothing in the overlay has focus after a keyboard send.',
  );
  checkStops('keyboard journey', stops);
}

async function escapeKey(ctx, session) {
  const url = ctx.origin + '/shop.html?keyboard=escape';
  const page = await session.open(url);
  await tabToPage(page, 'buy');
  await page.open();
  await page.key('Escape');
  await closedOverlay(page);
  equal(
    'Escape in the picker closes Nitpost and returns focus to the page',
    await page.eval('document.activeElement.id'),
    'buy',
  );

  await page.open();
  await page.press('pick-area');
  await page.click(960, 450);
  await page.when('the first corner', view => view.lead === 'Now click the opposite corner');
  await page.key('Escape');
  let view = await page.view();
  equal(
    'Escape after one corner cancels the corner, not the picker',
    [view?.mode, view?.lead],
    ['pick', 'Drag over an area, or click two corners'],
  );

  await page.press('pick-element');
  await page.clickPage('title');
  await page.when('the note editor', next => next.editor);
  await page.type('A comment that Escape will discard');
  await page.key('Escape');
  await closedOverlay(page);
  equal(
    'Escape in the editor of a first note closes Nitpost and discards the typed comment',
    await session.stored(notesKey(url)),
    undefined,
  );
  observe(
    'Escape in the editor discards a typed comment without asking. With no saved notes it also ' +
      'closes Nitpost.',
  );

  await page.open();
  await addNote(page, 'title', 'A saved note');
  await page.clickPage('buy');
  await page.when('the note editor', next => next.editor);
  await page.key('Escape');
  view = await settled(page);
  equal('with saved notes, Escape in the editor returns to the list', view.notes.length, 1);
  await page.key('Escape');
  await closedOverlay(page);
  check(
    'Escape in the list closes Nitpost and keeps the note',
    (await session.stored(notesKey(url))).length === 1,
  );
}

async function keyboardOnly(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation, otherConversation], send: receipts.confirmed.reply});
    await keyboardNote(ctx, session);
    await escapeKey(ctx, session);
  });
}

// Runs inside the overlay's shadow root. Lists what leaves the viewport and which controls clip
// their text.
function overlayLayout() {
  const problems = [];
  const describe = node =>
    node.localName +
    (node.dataset.control
      ? '[' + node.dataset.control + ']'
      : typeof node.className === 'string' && node.className
        ? '.' + node.className.trim().split(/\s+/).join('.')
        : '') +
    ' “' +
    node.textContent.replace(/\s+/g, ' ').trim().slice(0, 30) +
    '”';
  // Layers that cover the page or follow page elements are not controls.
  const layers =
    '.shield, .scrim, .outline, .outline *, .marks, .marks *, .spoken, .pins, svg *, ' +
    'input[type="file"]';
  for (const node of this.querySelectorAll('*')) {
    if (node.matches(layers) || !node.checkVisibility({visibilityProperty: true})) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    let [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom];
    // Content scrolled out of sight inside a scrolling panel is not outside the viewport.
    for (let up = node.parentElement; up; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = up.getBoundingClientRect();
      left = Math.max(left, clip.left);
      top = Math.max(top, clip.top);
      right = Math.min(right, clip.right);
      bottom = Math.min(bottom, clip.bottom);
    }
    if (right <= left || bottom <= top) continue;
    if (left < -0.5 || top < -0.5 || right > innerWidth + 0.5 || bottom > innerHeight + 0.5) {
      problems.push(
        describe(node) +
          ' extends past the viewport: ' +
          [left, top, right, bottom].map(Math.round).join(', '),
      );
    }
    const clipped =
      node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
    if (node.matches('button, a, .key, summary') && clipped) {
      problems.push(
        describe(node) +
          ' clips its text: content ' +
          node.scrollWidth +
          ' × ' +
          node.scrollHeight +
          ' in a box of ' +
          node.clientWidth +
          ' × ' +
          node.clientHeight,
      );
    }
  }
  return problems;
}

const viewports = [
  [1280, 800],
  [860, 800],
  [480, 800],
  [360, 640],
];

async function checkLayout(page, state) {
  for (const [width, height] of viewports) {
    await page.resize(width, height);
    await delay(300);
    const problems = await page.overlay(overlayLayout);
    await page.shot('layout-' + state + '-' + width);
    check(
      state + ' at ' + width + ' px: nothing leaves the viewport and no control clips its text',
      problems.length === 0,
      [...new Set(problems)].join('\n          '),
    );
  }
  await page.resize(1280, 800);
}

async function layout(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({
      targets: [conversation, otherConversation],
      send: receipts.unconfirmed.reply,
    });
    const file = path.join(session.home, 'wanted.png');
    fs.writeFileSync(file, png(640, 360, [200, 30, 90]));
    const page = await session.open(ctx.origin + '/shop.html?layout=1');
    await page.open();
    await checkLayout(page, 'pick');
    await addNote(
      page,
      'title',
      'Make the heading smaller, and keep it on one line at every width we support',
    );
    await page.press('pick-group');
    for (const id of ['oak', 'walnut']) await page.clickPage(id);
    await page.when('two marked elements', view => view.marks === 2);
    await checkLayout(page, 'pick-group-with-notes');
    await page.press('pick-element');
    await page.clickPage('buy');
    await page.when('the note editor', view => view.editor?.tiles[0]?.painted);
    await attachFile(page, file);
    await page.when('the reference image', view => view.editor.tiles[1]?.state === 'shown');
    await checkLayout(page, 'editor-both-images');
    await writeNote(page, 'Make the button look like the reference');
    await review(page);
    await chooseConversation(page, 'c');
    await sendNotes(page, 'unconfirmed');
    await checkLayout(page, 'review-attempt');
    await recheck(page, session, 'connected');
    await checkLayout(page, 'review-attempt-with-route-details');
  });
  await withSession(ctx, {helper: false}, async session => {
    const page = await session.open(ctx.origin + '/shop.html?layout=missing');
    await page.open();
    await addNote(page, 'title', 'A note with no helper to send it');
    await review(page, view => view.connection === 'missing');
    await checkLayout(page, 'review-helper-missing');
  });
}

const accepted = session => session.host.deliveries().filter(request => request.accepted);

// Tasks 1 to 4 of research/beta-protocol.md, as far as a browser can run them: first note, a second
// origin with the remembered destination, the destination closing before the third send, recovery.
async function pilotFirstNote(ctx, session) {
  const own = ctx.origin + '/shop.html';
  const page = await session.open(own);
  await page.open();
  await addNote(page, 'buy', 'Task 1: make this button green');
  await review(page);
  await chooseConversation(page, 'c');
  const view = await sendNotes(page, 'confirmed');
  includes(
    'task 1: the first receipt names the chosen conversation',
    view.attempt.title,
    'Received by Codex · site',
  );
  equal(
    'task 1: one batch reached that conversation',
    accepted(session).map(request => [request.block, request.page, request.notes[0].comment]),
    [[conversation.block, own, 'Task 1: make this button green']],
  );
  return page;
}

async function pilotSecondSite(ctx, session) {
  const reference = ctx.secondOrigin + '/shop.html';
  const second = await session.open(reference);
  let view = await second.open();
  equal(
    'task 2: a different site starts with no drafts',
    [view.mode, view.notes.length],
    ['pick', 0],
  );
  await addNote(second, 'title', 'Task 2: our heading should look like this one');
  view = await review(second, next => next.target?.value !== '');
  equal(
    'task 2: the destination is remembered across sites',
    [view.project.value, view.target.value],
    [conversation.project, conversation.block],
  );
  await sendNotes(second, 'confirmed');
  equal(
    'task 2: the note went to the same conversation',
    accepted(session)
      .slice(1)
      .map(request => [request.block, request.page]),
    [[conversation.block, reference]],
  );
}

// The conversation closes while the third note is on screen and ready to send.
async function pilotDestinationGone(ctx, session, page) {
  const third = ctx.origin + '/shop.html?task=3';
  await page.goto(third);
  await page.open();
  await addNote(page, 'lede', 'Task 3: shorten this paragraph');
  await review(page, next => control(next, 'send')?.disabled === false);
  session.host.set({
    targets: [otherConversation],
    send: {ok: false, error: 'That conversation is no longer open.', uncertain: false},
  });
  const view = await sendNotes(page, 'failed');
  await page.shot('pilot-task-3-destination-gone');
  includes(
    'task 3: the banner says it was not sent, and where',
    view.attempt.title,
    'Not sent to Codex · site',
  );
  includes(
    'task 3: with the reason and that the notes are kept',
    view.attempt.text,
    'That conversation is no longer open. Your notes are still here.',
  );
  includes(
    'task 3: the panel says the conversation is gone',
    view.facts.conversations?.text,
    'Codex · site is no longer available.',
  );
  equal(
    'task 3: the draft survives with its text',
    (await session.stored(notesKey(third))).map(note => note.comment),
    ['Task 3: shorten this paragraph'],
  );
  equal('task 3: nothing new was delivered', accepted(session).length, 2);
  return third;
}

async function pilotRecovery(session, page, third) {
  const result = await recheck(page, session, 'connected');
  equal(
    'task 4: Check again finds the conversation still gone and sends nothing',
    [result.view.route?.gone, control(result.view, 'send')?.disabled, accepted(session).length],
    [true, true, 2],
  );
  await page.press('copy');
  await page.when('the copy to be reported', next => next.status.includes('Copied'));
  includes(
    'task 4: Copy for agent carries the third note',
    await clipboard(page),
    'Task 3: shorten this paragraph',
  );
  equal(
    'task 4: copying leaves the draft and the failed record in place',
    [
      (await session.stored(notesKey(third))).length,
      (await session.stored(attemptKey(third))).status,
    ],
    [1, 'failed'],
  );
  session.host.set({targets: [otherConversation], send: receipts.submitted.reply});
  await choose(page, 'nitpost-target', 't');
  await page.when(
    'another conversation to be chosen',
    next => control(next, 'send')?.disabled === false,
  );
  const view = await sendNotes(page, 'submitted');
  includes(
    'task 4: the note reaches another conversation',
    view.attempt.title,
    'Entered in ' + otherConversation.label,
  );
  equal(
    'task 4: drafts are cleared once it is delivered',
    await session.stored(notesKey(third)),
    undefined,
  );
  const delivered = accepted(session).flatMap(request =>
    request.notes.map(note => note.comment + ' -> ' + request.block),
  );
  equal('every note was delivered exactly once, to the conversation chosen for it', delivered, [
    'Task 1: make this button green -> ' + conversation.block,
    'Task 2: our heading should look like this one -> ' + conversation.block,
    'Task 3: shorten this paragraph -> ' + otherConversation.block,
  ]);
}

async function pilot(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation, otherConversation], send: receipts.confirmed.reply});
    const page = await pilotFirstNote(ctx, session);
    await pilotSecondSite(ctx, session);
    const third = await pilotDestinationGone(ctx, session, page);
    await pilotRecovery(session, page, third);
  });
}

// ---- The built companion against a fake Codex owner server -----------------------------------

const codexThread = '11111111-1111-4111-8111-111111111111';

function takeFrame(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 127;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buffer[1] & 128) !== 0;
  const start = offset + (masked ? 4 : 0);
  if (buffer.length < start + length) return null;
  const payload = Buffer.from(buffer.subarray(start, start + length));
  if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[offset + (i % 4)];
  return {opcode: buffer[0] & 15, payload, rest: buffer.subarray(start + length)};
}

function textFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.alloc(4, 0x81);
  if (body.length >= 126) {
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  }
  return Buffer.concat([head, body]);
}

// What the owner server answers, as companion/tests/host.rs fakes it. Undefined means no reply.
function codexReply(request, turns) {
  if (request.method === 'initialized') return undefined;
  if (request.method === 'initialize') return {result: {}};
  if (request.method === 'thread/loaded/list')
    return {result: {data: [codexThread], nextCursor: null}};
  if (request.method === 'thread/read') {
    return {
      result: {
        thread: {
          id: request.params.threadId,
          source: 'cli',
          parentThreadId: null,
          status: {type: 'idle'},
          cwd: '/work/site',
          name: 'Landing page',
        },
      },
    };
  }
  if (request.method === 'turn/start') {
    turns.push(request.params);
    return {result: {turn: {id: 'turn-1'}}};
  }
  return {error: {code: -32601, message: 'Unexpected request ' + request.method}};
}

// JSON-RPC over WebSocket on a Unix socket: a stand-in for a Codex thread, owned by this test.
function serveCodex(socketPath) {
  const turns = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /sec-websocket-key:\s*(\S+)/i.exec(buffer.subarray(0, end).toString())[1];
        const accept = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' +
            accept +
            '\r\n\r\n',
        );
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      for (let frame = takeFrame(buffer); frame; frame = takeFrame(buffer)) {
        buffer = frame.rest;
        if (frame.opcode === 8) socket.end();
        if (frame.opcode !== 1) continue;
        const request = JSON.parse(frame.payload.toString('utf8'));
        const reply = codexReply(request, turns);
        if (reply) socket.write(textFrame({...reply, id: request.id}));
      }
    });
  });
  return new Promise(resolve =>
    server.listen(socketPath, () =>
      resolve({
        turns,
        close() {
          server.close();
          fs.rmSync(socketPath, {force: true});
        },
      }),
    ),
  );
}

// Recovers the batch from the single shell-quoted argument an agent receives.
function batchOf(message) {
  const intro = "Web annotations from Nitpost: '";
  if (!message.startsWith(intro) || !message.endsWith("'"))
    throw new Error('Unexpected message: ' + message.slice(0, 80));
  return JSON.parse(message.slice(intro.length, -1));
}

// The companion runs with nothing from this machine's environment: a HOME and agent directories
// inside the temporary profile, and a PATH that holds no agent.
function registerCompanion(session, binary) {
  for (const dir of systemPath.split(':')) {
    for (const agent of ['claude', 'codex', 'tmux', 'rex']) {
      if (fs.existsSync(path.join(dir, agent)))
        throw new Error(dir + '/' + agent + ' is a real agent on the test PATH.');
    }
  }
  const sandbox = path.join(session.home, 'companion');
  for (const name of ['home', 'bin', 'codex', 'claude/sessions'])
    fs.mkdirSync(path.join(sandbox, name), {recursive: true});
  const variables = {
    HOME: path.join(sandbox, 'home'),
    PATH: path.join(sandbox, 'bin') + ':' + systemPath,
    CLAUDE_CONFIG_DIR: path.join(sandbox, 'claude'),
    CODEX_HOME: path.join(sandbox, 'codex'),
    NITPOST_CODEX_SOCKET: path.join(sandbox, 'codex.sock'),
  };
  session.host.register(
    'exec /usr/bin/env -i ' +
      Object.entries(variables)
        .map(([name, value]) => name + '="' + value + '"')
        .join(' ') +
      ' "' +
      binary +
      '" "$@"',
  );
  return {
    sandbox,
    socket: variables.NITPOST_CODEX_SOCKET,
    shots: path.join(variables.HOME, 'Library/Caches/com.micovi.nitpost/shots'),
  };
}

function checkCodexTurn(turn, url, shots) {
  equal(
    'the turn went to the listed thread as one text input',
    [turn.threadId, turn.input.length, turn.input[0].type],
    [codexThread, 1, 'text'],
  );
  const batch = batchOf(turn.input[0].text);
  equal('the agent is told the source page', batch['Source page'], url);
  equal(
    'the element note carries its selector and excerpt',
    [batch.notes[0]['Selected element'].selector, batch.notes[0]['Selected element'].text],
    ['#title', 'Lounge chair'],
  );
  equal(
    'the area note carries its rect and no selector',
    [batch.notes[1]['Selected area'].rect, JSON.stringify(batch.notes[1]).includes('selector')],
    [firstArea, false],
  );
  const files = batch.notes.map(
    note => (note['Selected element'] ?? note['Selected area']).screenshot,
  );
  check(
    'each screenshot is a JPEG file in the temporary HOME',
    files.every(
      file =>
        path.dirname(file) === shots &&
        fs
          .readFileSync(file)
          .subarray(0, 2)
          .equals(Buffer.from([0xff, 0xd8])),
    ),
    JSON.stringify(files),
  );
}

async function realCompanion(ctx) {
  const binary = process.env.NITPOST_COMPANION;
  if (!binary) {
    observe(
      'skipped: set NITPOST_COMPANION to a built companion binary ' +
        '(cargo build --manifest-path companion/Cargo.toml, then ' +
        'companion/target/debug/nitpost).',
    );
    return;
  }
  await withSession(ctx, {helper: false}, async session => {
    const {sandbox, socket, shots} = registerCompanion(session, path.resolve(binary));
    const url = ctx.origin + '/shop.html?companion=1';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'Make the heading smaller');
    await page.press('pick-area');
    await page.drag(950, 300, 1150, 420);
    await writeNote(page, 'Too much empty space here');

    let view = await review(page, next => next.connection === 'connected');
    equal(
      'an empty machine: the helper is reached and nothing is eligible',
      [view.route?.eligible, control(view, 'send')?.disabled],
      ['0', true],
    );
    equal(
      'each route says what it found',
      view.checks.map(item => item.route),
      ['claude', 'codex', 'tmux', 'rex'],
    );
    check(
      'the reasons name no path, socket or pid',
      !view.checks.some(item => item.text.includes(sandbox) || item.text.includes('.sock')),
      JSON.stringify(view.checks),
    );
    await page.shot('companion-empty-machine');

    const codex = await serveCodex(socket);
    try {
      view = await page
        .press('check')
        .then(() => settled(page, next => control(next, 'send')?.disabled === false));
      equal(
        'the fake Codex thread is listed and selected',
        view.target.options.find(option => option.value === view.target.value)?.text,
        'Codex · Landing page · 11111111 · live server',
      );
      view = await sendNotes(page, 'confirmed');
      includes(
        'the receipt is the one Codex gave',
        view.attempt.text,
        'Codex accepted the turn in the selected thread.',
      );
      includes('and names the thread', view.attempt.title, 'Received by Codex · Landing page');
      equal(
        'one turn was started and the drafts are cleared',
        [codex.turns.length, view.notes.length],
        [1, 0],
      );
      checkCodexTurn(codex.turns[0], url, shots);
      await page.shot('companion-confirmed');

      await page.press('pick');
      await page.when('the picker', next => next.mode === 'pick');
      await addNote(page, 'buy', 'Written just before the thread closed');
      await review(page, next => control(next, 'send')?.disabled === false);
    } finally {
      codex.close();
    }
    view = await sendNotes(page, 'failed');
    includes(
      'with the thread gone, the send is reported as not sent',
      view.attempt.title,
      'Not sent to Codex · Landing page',
    );
    includes('with the helper’s way forward', view.attempt.text, 'Refresh destinations');
    equal(
      'the draft is kept and no second turn was started',
      [view.notes.map(note => note.comment), codex.turns.length],
      [['Written just before the thread closed'], 1],
    );
    await page.shot('companion-thread-gone');
  });
}
// ---- Stale tabs, hostile pages, a stopped worker and helpers that hang -----------------------

const supersededText = 'This page was sent again or settled in another tab.';

// Two tabs on one URL, both showing the same unconfirmed attempt of one note.
async function twoTabsWithAttempt(session, url) {
  session.host.set({targets: [conversation], send: receipts.unconfirmed.reply});
  const first = await session.open(url);
  await first.open();
  await addNote(first, 'title', 'Note shown in two tabs');
  await review(first, view => control(view, 'send')?.disabled === false);
  await sendNotes(first, 'unconfirmed');
  const second = await session.open(url);
  await openReview(second, view => view.attempt?.status === 'unconfirmed');
  return [first, second];
}

async function staleTabs(ctx) {
  await withSession(ctx, {}, async session => {
    const resendUrl = ctx.origin + '/shop.html?stale=resend';
    let [first, second] = await twoTabsWithAttempt(session, resendUrl);
    const before = (await second.view()).attempt.datetime;
    await first.press('resend');
    await settled(
      first,
      next => next.attempt?.status === 'unconfirmed' && next.attempt.datetime !== before,
    );
    equal(
      'the first tab’s Send again delivers once more',
      deliveriesFrom(session, resendUrl).length,
      2,
    );
    await second.press('resend');
    let view = await settled(second, next => next.status.includes('another tab'), 6000).catch(() =>
      second.view(),
    );
    includes('Send again in the stale tab is refused with the reason', view.status, supersededText);
    await delay(1000);
    equal('and delivers nothing more', deliveriesFrom(session, resendUrl).length, 2);
    check(
      'the stale tab now shows the newer record',
      view.attempt?.datetime !== before &&
        view.attempt?.datetime === (await first.view()).attempt.datetime,
      JSON.stringify(view.attempt),
    );
    await second.shot('stale-send-again');

    const receivedUrl = ctx.origin + '/shop.html?stale=received';
    [first, second] = await twoTabsWithAttempt(session, receivedUrl);
    await first.press('dismiss');
    await settled(first, next => !next.attempt);
    await first.press('pick');
    await first.when('the picker', next => next.mode === 'pick');
    await addNote(first, 'buy', 'Added after the first batch');
    await review(first, next => control(next, 'send')?.disabled === false);
    await sendNotes(first, 'unconfirmed');
    await second.press('received');
    view = await settled(second, next => next.status.includes('another tab'), 6000).catch(() =>
      second.view(),
    );
    includes('Mark as received in the stale tab is refused', view.status, supersededText);
    equal(
      'the newer batch keeps both notes',
      (await session.stored(notesKey(receivedUrl))).map(note => note.comment),
      ['Note shown in two tabs', 'Added after the first batch'],
    );
    equal('and its record', (await session.stored(attemptKey(receivedUrl)))?.count, 2);
    equal(
      'the stale tab now shows both notes as part of the newer attempt',
      view.notes.map(note => note.attempt),
      ['unconfirmed', 'unconfirmed'],
    );
  });
}

const hostileFields = [
  'checkout',
  'field-parent',
  'field-children',
  'field-id',
  'field-attribute',
  'field-closest',
  'field-name',
  'field-connected',
  'field-rect',
  'field-contains',
  'form-text',
];

// Whether `selector` finds exactly the element with `id`, asked without the properties the page
// clobbers.
function matchesOnly(page, selector, id) {
  return page.eval(
    '(() => { const found = Document.prototype.querySelectorAll.call(document, ' +
      JSON.stringify(selector) +
      '); return found.length === 1 && found[0] === Document.prototype.getElementById' +
      '.call(document, ' +
      JSON.stringify(id) +
      '); })()',
  );
}

async function hostileForm(session, ctx) {
  const url = ctx.origin + '/hostile.html';
  const page = await session.open(url);
  await page.open();
  for (const id of hostileFields) {
    const rect = await page.rect(id);
    await page.click(rect.x + 4, rect.y + 4);
    // A hang here must fail this check, not stall the run.
    const view = await page.when('the note editor', next => next.editor, 5000).catch(() => null);
    const selector = view?.editor.context ?? null;
    check(
      '#' + id + ' in the clobbering form is picked, with a selector that finds only it',
      selector !== null && (await matchesOnly(page, selector, id)),
      'selector: ' + JSON.stringify(selector),
    );
    if (!view) continue;
    await page.clickOverlay('.editor textarea');
    await page.type('Note on ' + id);
    await page.press('save');
    await page.when('the note to be saved', next => next.mode === 'pick', 5000);
  }
  await page.eval('Document.prototype.getElementById.call(document, "field-children").focus()');
  await page.key('m');
  const view = await page.view();
  equal(
    'M typed into a text field does not change the pick mode',
    [
      view.pick,
      await page.eval(
        'Document.prototype.getElementById.call(document, "field-children").value.length',
      ),
    ],
    ['element', 2],
  );
  await page.key('Enter');
  const picked = await page.when('the note editor', next => next.editor, 5000).catch(() => null);
  equal(
    'Enter picks the focused field of the clobbering form',
    picked?.editor.context ?? null,
    '#field-children',
  );
  equal(
    'every pick was stored',
    (await session.stored(notesKey(url))).length,
    hostileFields.length,
  );
  await page.shot('hostile-form');
}

async function hostRemoved(session, ctx) {
  const page = await session.open(ctx.origin + '/shop.html?hostile=removed');
  await page.open();
  const buy = await page.rect('buy');
  await page.move(buy.x + 20, buy.cy);
  await page.down(buy.x + 20, buy.cy);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: buy.x + 26,
    y: buy.cy + 3,
    button: 'left',
    buttons: 1,
  });
  await page.up(buy.x + 26, buy.cy + 3);
  const slipped = await page
    .when('the note editor', next => next.editor, 5000)
    .catch(() => page.view());
  equal(
    'a 7 px slip of the pointer in Element mode still picks the element',
    [slipped?.editor?.context ?? null, slipped?.statusError ?? null],
    ['#buy', false],
  );
  await page.press('cancel');
  await closedOverlay(page);

  await page.open();
  await page.eval('document.documentElement.replaceChildren(document.head, document.body)');
  await delay(300);
  await page.eval(
    'window.keysSeen = []; menuLog.length = 0;' +
      'addEventListener("keydown", event => keysSeen.push(event.key))',
  );
  await page.clickPage('buy');
  equal(
    'after the page removes the overlay, a click reaches the page',
    await page.eval('menuLog'),
    ['click:buy'],
  );
  for (const key of ['Enter', 'Escape', 'ArrowUp', 'm']) await page.key(key);
  equal('and so do the keys the picker used', await page.eval('keysSeen'), [
    'Enter',
    'Escape',
    'ArrowUp',
    'm',
  ]);
  const view = await page.open().catch(() => null);
  equal('the next toolbar click opens Nitpost again', view?.mode ?? null, 'pick');
}

async function hostilePages(ctx) {
  await withSession(ctx, {}, async session => {
    await hostileForm(session, ctx);
    await hostRemoved(session, ctx);
  });
}

async function workerStopped(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?worker=stopped';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'Sent just before Chrome stopped the worker');
    await review(page, view => control(view, 'send')?.disabled === false);
    session.host.set({targets: [conversation], delivery: 'hang'});
    await page.press('send');
    await until('the send to reach the helper', () => deliveriesFrom(session, url).length === 1);
    const {targetInfos} = await session.rpc('Target.getTargets');
    const worker = targetInfos.find(
      info => info.type === 'service_worker' && info.url.includes(extensionId),
    );
    await session.rpc('Target.closeTarget', {targetId: worker.targetId});
    session.host.set({targets: [conversation]});
    const view = await settled(page, next => next.attempt, 15000);
    await page.shot('worker-stopped');
    equal(
      'with the worker stopped mid-send, the record reads as no result',
      view.attempt.status,
      'unknown',
    );
    includes(
      'and says Chrome stopped Nitpost',
      view.attempt.text,
      'Chrome stopped Nitpost before the helper answered.',
    );
    equal(
      'the bar stays connected and the note is kept',
      [view.connection, view.notes.map(note => note.attempt)],
      ['connected', ['unknown']],
    );
    check(
      'the tab is not told to reload',
      !/reload/i.test(view.status + ' ' + view.panel),
      view.status + ' | ' + view.panel,
    );
    equal('one request reached the helper', deliveriesFrom(session, url).length, 1);
  });
}

// Discovery that gets no answer: the bar must leave “checking” by itself and no other tab may
// wait.
async function hungDiscovery(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const page = await session.open(ctx.origin + '/shop.html?hung=discovery');
    await page.open();
    await addNote(page, 'title', 'A note waiting for discovery');
    await review(page);
    session.host.set({discovery: 'hang'});
    const started = Date.now();
    await page.press('check');
    await page.when('checking', view => view.connection === 'checking');
    const other = await session.open(ctx.origin + '/account.html');
    await other.open();
    await addNote(other, 'billing-title', 'Written while another tab is still checking');
    await other.press('review');
    const elsewhere = await other
      .when(
        'the list in the other tab',
        view => view.mode === 'review' && view.notes.length === 1,
        5000,
      )
      .catch(() => null);
    equal(
      'another tab can add and list notes while discovery hangs',
      elsewhere?.notes.length ?? null,
      1,
    );
    equal('the first tab is still checking meanwhile', (await page.view()).connection, 'checking');
    const view = await page.when(
      'discovery to give up',
      next => next.connection !== 'checking',
      45000,
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    equal(
      'the bar leaves “checking” by itself and reports the helper as not responding',
      [view.connection, view.facts.helper?.state],
      ['unreachable', 'problem'],
    );
    check('within about 30 seconds', seconds >= 25 && seconds <= 40, seconds + ' s');
    equal(
      'the note is still there and Copy for agent is offered',
      [view.notes.length, control(view, 'copy')?.disabled],
      [1, false],
    );
    await page.shot('hung-discovery');
  });
}

// A helper that never answers the question the worker asks before a batch with a screenshot.
async function hungCapabilities(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?hung=capabilities';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'Note for a helper that never says what it accepts');
    await review(page, view => control(view, 'send')?.disabled === false);
    session.host.set({targets: [conversation], capabilities: 'hang'});
    const started = Date.now();
    await page.press('send');
    await until(
      'the worker to ask the helper',
      () => session.host.requests('capabilities').length === 1,
    );
    includes(
      'while the helper is silent the bar says it is sending',
      (await page.view()).status,
      'Sending notes…',
    );
    const view = await settled(page, next => next.attempt, 20000);
    const seconds = Math.round((Date.now() - started) / 1000);
    equal(
      'the worker gives up and reports the batch as not sent, with the note kept',
      [view.attempt.status, view.notes.length, deliveriesFrom(session, url).length],
      ['failed', 1, 0],
    );
    check('after about 10 seconds', seconds >= 8 && seconds <= 15, seconds + ' s');
    const other = await session.open(ctx.origin + '/account.html');
    await other.open();
    await addNote(other, 'billing-title', 'Written after the worker stopped waiting');
    equal('another page can be annotated afterwards', (await other.view()).notes.length, 1);
    await page.shot('hung-capabilities');
  });
}

// A send whose helper answers after the worker has stopped waiting. This waits two minutes, so it
// runs last.
async function hungSend(ctx) {
  await withSession(ctx, {}, async session => {
    session.host.set({targets: [conversation]});
    const url = ctx.origin + '/shop.html?hung=send';
    const page = await session.open(url);
    await page.open();
    await addNote(page, 'title', 'Note for a helper that answers too late');
    await review(page, view => control(view, 'send')?.disabled === false);
    session.host.set({targets: [conversation], send: receipts.submitted.reply, delay: 128000});
    await page.press('send');
    const started = Date.now();
    await until('the send to reach the helper', () => deliveriesFrom(session, url).length === 1);
    await delay(1500);
    includes(
      'while the helper is silent the bar says it is sending',
      (await page.view()).status,
      'Sending notes…',
    );
    equal(
      'the record is pending in storage',
      (await session.stored(attemptKey(url)))?.status,
      'pending',
    );
    await page.reload();
    await page.activate();
    const other = await session.open(ctx.origin + '/account.html');
    await other.activate();
    const early = await other
      .when('the overlay on another page', view => view.mode !== 'idle', 5000)
      .catch(() => null);
    await page.shot('hung-send-waiting');
    observe(
      'hung send: for the two minutes the worker waits, a toolbar click on ' +
        (early
          ? 'another page opens Nitpost normally.'
          : 'any page dims it and shows no control: every request ' +
            'from every tab queues behind the unanswered send until the 120 s limit.'),
    );
    const view = await page.when('the worker to stop waiting', next => next.attempt, 140000);
    const seconds = Math.round((Date.now() - started) / 1000);
    equal(
      'after the limit the attempt reads as no result and the note is kept',
      [view.attempt.status, view.notes.map(note => note.attempt)],
      ['unknown', ['unknown']],
    );
    check(
      'the worker stopped waiting after about 120 seconds',
      seconds >= 115 && seconds <= 127,
      seconds + ' s',
    );
    const released = await other
      .when('the overlay on another page', next => next.mode !== 'idle', 5000)
      .catch(() => null);
    check('other tabs work again once it has stopped waiting', released !== null);
    await delay(Math.max(0, 128000 + 4000 - (Date.now() - started)));
    equal(
      'the helper’s late answer changes nothing',
      [
        (await session.stored(attemptKey(url)))?.status,
        (await session.stored(notesKey(url)))?.length,
      ],
      ['unknown', 1],
    );
    equal('one request reached the helper', deliveriesFrom(session, url).length, 1);
  });
}

const scenarios = {
  'copy without a helper': copyWithoutHelper,
  'copy on an insecure page': copyOnInsecurePage,
  'copy after the extension context is gone': copyAfterInvalidation,
  'connection states': connectionStates,
  'attempt records': attemptRecords,
  'silent helper and interrupted worker': silentHelper,
  'legacy helper': legacyHelper,
  'double activation of Send': doubleActivation,
  'screenshot preview and omission': screenshotChoice,
  'privacy: omit the crop': privacyOmit,
  'reference image': referenceImage,
  'area notes': areaNotes,
  'grouped elements': groupNotes,
  'transient menus and the shortcut': transientMenus,
  'data from earlier betas': dataMigration,
  'source-URL isolation and navigation': isolation,
  offline: offline,
  'keyboard only': keyboardOnly,
  layout: layout,
  'pilot tasks 1 to 4': pilot,
  'built companion with a fake Codex thread': realCompanion,
  'stale tabs': staleTabs,
  'hostile pages': hostilePages,
  'service worker stopped mid-send': workerStopped,
  'discovery that hangs': hungDiscovery,
  'capabilities that hang': hungCapabilities,
  'send that hangs for two minutes': hungSend,
};

async function main() {
  const executable = process.argv[2];
  if (!executable || !fs.existsSync(executable)) {
    throw new Error('Pass the Chrome for Testing executable path as the first argument.');
  }
  if (shotsDir) fs.mkdirSync(shotsDir, {recursive: true});
  const chosen = process.argv.slice(3);
  const server = await serveFixtures();
  const port = server.address().port;
  const ctx = {
    port,
    origin: 'http://127.0.0.1:' + port,
    secondOrigin: 'http://localhost:' + port,
    insecureOrigin: 'http://insecure.test:' + port,
    launch: options => launch(executable, options),
  };
  console.log(execFileSync(executable, ['--version']).toString().trim());
  try {
    for (const [name, run] of Object.entries(scenarios)) {
      if (chosen.length && !chosen.includes(name)) continue;
      scenarioName = name;
      console.log('\n' + name);
      try {
        await run(ctx);
      } catch (error) {
        check('scenario ran to the end', false, error.stack);
      }
    }
  } finally {
    server.close();
  }
  const failed = results.filter(result => !result.ok);
  const passed = results.filter(result => result.ok && !result.observed);
  console.log('\n' + passed.length + ' checks passed, ' + failed.length + ' failed.');
  for (const result of failed) console.log('FAILED  ' + result.scenario + ': ' + result.name);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
