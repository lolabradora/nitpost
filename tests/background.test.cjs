const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../extension/background.js'), 'utf8');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// One service worker instance over `values`, which stands in for chrome.storage.local and outlives it.
function worker(native, values = {}, browser = {}) {
  let listener;
  const chrome = {
    action: {
      onClicked: {addListener(callback) { browser.clicked = callback; }},
      setTitle: async details => { browser.titles?.push(clone(details)); },
      setBadgeText: async () => {}
    },
    commands: {getAll: async () => [{name: '_execute_action', shortcut: browser.shortcut ?? ''}]},
    scripting: {executeScript: async () => {}},
    tabs: {
      captureVisibleTab: browser.capture ?? (async () => { throw new Error('No capture'); }),
      get: async id => ({id, active: browser.stillActive?.() ?? true}),
      create: browser.create ?? (async details => { browser.opened?.push(clone(details)); })
    },
    runtime: {
      id: 'nitpost', sendNativeMessage: async (_, request) => native(clone(request)),
      getManifest: () => browser.manifest ?? {version: '0.3.0.2', version_name: '0.3.0-beta.2'},
      setUninstallURL: browser.setUninstallURL ?? (async () => {}),
      onMessage: {addListener(callback) { listener = callback; }}
    },
    storage: {local: {
      getKeys: async () => Object.keys(values),
      get: async keys => {
        browser.reads?.push(keys);
        return clone(Object.fromEntries(keys.map(key => [key, values[key]])));
      },
      set: async changes => {
        browser.beforeSet?.(changes);
        Object.assign(values, clone(changes)); // Chrome stores a serialized copy.
      },
      remove: async key => { delete values[key]; }
    }}
  };
  const navigator = {userAgentData: {
    platform: 'macOS', brands: [{brand: 'Not?A_Brand', version: '99'}, {brand: 'Chromium', version: '151'}]
  }};
  const globals = {chrome, URL, setTimeout, clearTimeout, btoa, console, navigator, ...browser.globals};
  vm.runInNewContext(source, globals);
  return (op, fields = {}, page = 'https://example.test/p', tab = {}) => new Promise(resolve => {
    const sender = {id: 'nitpost', frameId: 0, tab: {id: 3, active: true, windowId: 7, ...tab}, url: page};
    listener({op, page, ...fields}, sender, reply => resolve(clone(reply))); // Replies come from another realm.
  });
}

// Timers the test advances by hand, passed to a worker as browser.globals.
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    globals: {
      setTimeout(callback, delay, ...args) { timers.set(next, {due: now + delay, callback, args}); return next++; },
      clearTimeout(id) { timers.delete(id); }
    },
    waiting: () => [...timers.values()].map(timer => timer.due - now),
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.callback(...timer.args);
      }
      for (let turn = 0; turn < 20; turn += 1) await new Promise(setImmediate);
    }
  };
}

// A helper call the test resolves by hand, to observe the worker while a send is in flight.
function heldHelper(reply) {
  const calls = [];
  let started;
  let release;
  const reached = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const native = async msg => {
    calls.push(msg);
    if (msg.op === 'capabilities') return {ok: true, shots: true, payload: 2};
    started();
    await held;
    return reply;
  };
  return {native, calls, reached, release};
}

const page = 'https://example.test/p';
const notesKey = 'notes:' + page;
const attemptKey = 'attempt:' + page;
const target = {block: 'block:1', session: 'session:1', label: 'Review'};
const jpeg = 'data:image/jpeg;base64,/9j/4A==';
const pasted = 'data:image/jpeg;base64,/9j/2w==';
const current = {ok: true, shots: true, payload: 2};

function note(id) {
  return {id, selector: '#save', text: 'Save', comment: 'Align label', width: 1024, height: 768};
}
function areaNote(id) {
  return {id, scope: 'area', rect: {x: 10, y: 2400, width: 300, height: 120}, comment: 'Reduce this gap', width: 1024, height: 768};
}
function groupNote(id) {
  const elements = [{selector: '#name', text: 'Name'}, {selector: '#email', text: 'Email'}];
  return {id, scope: 'group', elements, comment: 'Align these', width: 1024, height: 768};
}
// A helper that answers capability questions as the current release does and otherwise replies `reply`.
function helper(reply, calls = []) {
  return async msg => {
    calls.push(msg);
    if (msg.op === 'capabilities') return current;
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

test('concurrent tabs preserve additions and can send a selected batch only once', async () => {
  const deliveries = [];
  const request = worker(async msg => { deliveries.push(msg); return {ok: true}; });
  await Promise.all(['a', 'b'].map(id => request('add', {note: note(id)})));
  const responses = await Promise.all([1, 2].map(() => request('send', {ids: ['a'], target})));
  assert.deepEqual(responses.map(r => r.ok), [true, false]);
  assert.match(responses[1].error, /notes have changed/);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].notes.length, 1);
  assert.equal((await request('state')).notes[0].id, 'b');
});

test('bridge failure preserves notes and successful retry clears the batch', async () => {
  let online = false;
  const request = worker(async () => online ? {ok: true} : {ok: false, error: 'Agent closed', uncertain: false});
  await request('add', {note: note('a')});
  const send = () => request('send', {ids: ['a'], target});
  const failed = await send();
  assert.equal(failed.error, 'Agent closed');
  assert.equal(failed.attempt.status, 'failed');
  assert.equal((await request('state')).notes.length, 1);
  online = true;
  assert.equal((await send()).ok, true); // Nothing was delivered, so no resend confirmation is needed.
  assert.equal((await request('state')).notes.length, 0);
});

test('drafts belong to a URL and the preferred destination follows you across sites', async () => {
  const request = worker();
  await request('add', {note: note('a')});
  await request('select', {target});
  const elsewhere = await request('state', {}, 'https://example.test/other');
  assert.equal(elsewhere.notes.length, 0);
  assert.equal(elsewhere.target.block, target.block);
  assert.equal((await request('state', {}, 'https://other.test/')).target.block, target.block);
  const next = {...target, project: '/other', block: 'block:2'};
  await request('select', {project: next.project, target: next}, 'https://other.test/');
  const back = await request('state');
  assert.equal(back.target.block, next.block);
  assert.equal(back.notes[0].id, 'a');
});

test('a global project selection overrides legacy per-repository defaults', async () => {
  const request = worker(undefined, {'target:https://github.com': target});
  const repo = 'https://github.com/Sureshot-Labs/starter';
  const project = '/Users/test/dev/starter';
  assert.equal((await request('state', {}, repo)).target, null);
  await request('select', {project, target: null}, repo);
  assert.equal((await request('state', {}, repo.toLowerCase() + '/pull/12')).project, project);
  const other = await request('state', {}, 'https://github.com/Sureshot-Labs/example');
  assert.equal(other.project, project);
  assert.equal(other.recentProjects[0], project);
});

test('v0.1 site preferences and drafts remain usable outside GitHub', async () => {
  const request = worker(undefined, {
    'target:https://example.test': target,
    'notes:https://example.test/p': [note('old')]
  });
  const state = await request('state');
  assert.equal(state.target.block, target.block);
  assert.equal(state.notes[0].id, 'old');
  assert.equal((await request('state', {}, 'https://new.test/')).target.block, target.block);
});

test('storage written by beta.1 and beta.2 loads, edits and sends unchanged', async () => {
  const repo = 'https://github.com/Sureshot-Labs/starter/pull/12';
  const project = '/Users/test/dev/starter';
  const beta1 = {id: 'one', selector: 'h1', text: 'Title', width: 1280, height: 720, comment: 'Tighten'};
  const beta2 = {id: 'two', selector: '#cta', text: 'Buy', width: 1280, height: 720, kind: 'question', comment: 'Why red?', image: jpeg};
  const values = {
    ['notes:' + repo]: [beta1, beta2],
    'destination:https://github.com/sureshot-labs/starter': {project, target: {...target, project}},
    'target:https://example.test': target,
    'recentProjects': [project]
  };
  const before = clone(values);
  const calls = [];
  const request = worker(helper({ok: true}, calls), values);

  const state = await request('state', {}, repo);
  assert.deepEqual(state.notes, [
    {...beta1, kind: 'change', shot: false, ref: false},
    {id: 'two', selector: '#cta', text: 'Buy', width: 1280, height: 720, kind: 'question', comment: 'Why red?', shot: true, ref: false}
  ]);
  assert.equal(state.project, project);
  assert.equal(state.target.block, target.block);
  assert.equal(state.attempt, null);
  assert.deepEqual(values['notes:' + repo], before['notes:' + repo]); // Reading rewrites nothing.
  assert.deepEqual(values.lastDestination, {project, target: {...target, project}});

  assert.deepEqual(await request('images', {id: 'two'}, repo), {ok: true, image: jpeg, reference: null});
  await request('edit', {id: 'one', comment: 'Tighten more'}, repo);
  assert.deepEqual(values['notes:' + repo], [{...beta1, comment: 'Tighten more'}, beta2]);

  const sent = await request('send', {ids: ['one', 'two'], target: state.target}, repo);
  assert.equal(sent.ok, true);
  assert.deepEqual(calls.at(-1), {
    op: 'send', session: target.session, block: target.block, project, page: repo,
    notes: [
      {selector: 'h1', text: 'Title', width: 1280, height: 720, comment: 'Tighten more', kind: 'change'},
      {selector: '#cta', text: 'Buy', width: 1280, height: 720, kind: 'question', comment: 'Why red?', image: jpeg}
    ]
  });

  // The per-origin key from v0.1 still seeds a profile that never chose a global destination.
  const legacy = worker(undefined, {'target:https://example.test': target});
  assert.equal((await legacy('state')).target.block, target.block);
});

for (const agent of ['codex', 'claude']) {
  test('start ' + agent + ' on submit and route future notes to the created conversation', async () => {
    const project = '/Users/test/Project with spaces';
    const created = {...target, project};
    const calls = [];
    const request = worker(async msg => {
      calls.push(msg);
      return {ok: true, target: created, receipt: 'submitted'};
    });
    const start = {agent, project};
    await request('select', {project, target: start});
    await request('add', {note: note('first')});
    assert.equal(calls.length, 0);
    const result = await request('send', {ids: ['first'], target: start});
    assert.equal(result.target.block, created.block);
    assert.deepEqual(result.attempt.target, {label: 'Review', project, session: 'session:1', block: 'block:1'});
    assert.equal(calls[0].op, 'start');
    assert.equal(calls[0].agent, agent);
    assert.equal(calls[0].project, project);
    assert.equal(calls[0].notes[0].comment, 'Align label');
    const state = await request('state');
    assert.equal(state.notes.length, 0);
    assert.equal(state.target.block, created.block);
    await request('add', {note: note('second')});
    await request('send', {ids: ['second'], target: state.target});
    assert.equal(calls[1].op, 'send');
    assert.equal(calls[1].block, created.block);
  });
}

test('a start that does not identify its conversation is unknown and keeps the notes', async () => {
  const project = '/project';
  const request = worker(async () => ({ok: true, receipt: 'submitted'}));
  await request('add', {note: note('a')});
  const reply = await request('send', {ids: ['a'], target: {agent: 'codex', project}});
  assert.equal(reply.ok, false);
  assert.equal(reply.attempt.status, 'unknown');
  assert.equal(reply.attempt.target.label, 'a new Codex conversation');
  assert.match(reply.error, /did not say which one/);
  assert.equal((await request('state')).notes.length, 1);
});

test('failed start keeps notes and cancelled folder choice leaves saved preferences intact', async () => {
  const project = '/project';
  const start = {project, agent: 'claude'};
  const request = worker(async msg => msg.op === 'chooseFolder'
    ? {ok: true, project: null} : {ok: false, error: 'Claude Code unavailable', uncertain: false});
  await request('select', {project, target: start});
  assert.equal((await request('chooseFolder')).project, null);
  await request('add', {note: note('a')});
  assert.equal((await request('send', {target: start, ids: ['a']})).ok, false);
  const state = await request('state');
  assert.equal(state.notes.length, 1);
  assert.equal(state.project, project);
  assert.equal(state.target.agent, 'claude');
});

test('retired routes are rejected before anything is recorded and their notes remain saved', async () => {
  const values = {};
  const request = worker(() => assert.fail('Unexpected delivery'), values);
  await request('add', {note: note('a')});
  for (const session of ['Terminal', 'iTerm2', 'codex-queue']) {
    assert.deepEqual(await request('send', {ids: ['a'], target: {...target, session}}),
      {ok: false, error: 'Choose a live conversation.', attempt: null});
  }
  assert.equal(attemptKey in values, false);
  assert.equal((await request('state')).notes.length, 1);
});

test('local files keep notes per URL and share the destination across folders', async () => {
  const sent = [];
  const request = worker(async message => { sent.push(message); return {ok: true}; });
  const page = 'file:///Users/test/site/index.html';
  await request('add', {note: note('a')}, page);
  await request('select', {target}, page);
  const sibling = await request('state', {}, 'file:///Users/test/site/about.html');
  assert.equal(sibling.target.block, target.block);
  assert.equal(sibling.notes.length, 0);
  assert.equal((await request('state', {}, 'file:///Users/test/other/index.html')).target.block, target.block);
  assert.equal((await request('state', {page: 'file:///different/file.html'}, page)).ok, false);
  assert.equal((await request('send', {ids: ['a'], target}, page)).ok, true);
  assert.equal(sent[0].page, page);
});

test('peer inbox preserves confirmation wording and never tries GUI focus', async () => {
  const calls = [];
  const request = worker(async msg => {
    calls.push(msg);
    return {ok: true, notice: 'Posted to the inbox.', keepNotes: true};
  });
  const inbox = {session: 'claude-inbox', block: 'claude-inbox:id:123', project: '/test', label: 'My terminal', focusable: false};
  await request('add', {note: note('a')});
  const result = await request('send', {ids: ['a'], target: inbox, focus: true});
  assert.equal(result.notice, 'Posted to the inbox.');
  assert.equal(result.receipt, 'unconfirmed');
  assert.deepEqual(calls.map(c => c.op), ['send']);
  assert.equal(calls[0].block, inbox.block);
  assert.equal('focus' in calls[0], false);
  assert.equal((await request('state')).notes.length, 1);
});

test('the page dim preference defaults on and is remembered', async () => {
  const request = worker(async () => ({ok: true}));
  assert.equal((await request('state')).dim, true);
  assert.equal((await request('dim', {on: false})).ok, true);
  assert.equal((await request('state')).dim, false);
  await request('dim', {on: true});
  assert.equal((await request('state')).dim, true);
});

test('notes default to change requests, accept questions and reject other kinds', async () => {
  const deliveries = [];
  const values = {[notesKey]: [note('old')]};
  const request = worker(async msg => { deliveries.push(msg); return {ok: true}; }, values);
  assert.equal((await request('add', {note: {...note('q'), kind: 'question'}})).ok, true);
  assert.match((await request('add', {note: {...note('x'), kind: 'praise'}})).error, /Change or Question/);
  assert.deepEqual((await request('state')).notes.map(item => item.kind), ['change', 'question']);
  assert.match((await request('edit', {id: 'old', comment: 'Why?', kind: 'answer'})).error, /Change or Question/);
  await request('edit', {id: 'old', comment: 'Why?', kind: 'question'});
  await request('edit', {id: 'q', comment: 'Make it bold'});
  assert.deepEqual((await request('state')).notes.map(item => [item.comment, item.kind]),
    [['Why?', 'question'], ['Make it bold', 'question']]);
  values[notesKey].push(note('legacy'));
  await request('send', {ids: ['old', 'q', 'legacy'], target});
  assert.deepEqual(deliveries[0].notes.map(item => item.kind), ['question', 'question', 'change']);
});

// A fake capture pipeline: an 800x600 device-pixel page whose JPEG size is set per test.
function camera(jpegBytes = () => 2000) {
  const calls = {captures: [], draws: [], encodes: []};
  class OffscreenCanvas {
    constructor(width, height) { Object.assign(this, {width, height}); }
    getContext() { return {drawImage: (...args) => calls.draws.push(args.slice(1))}; }
    async convertToBlob(options) {
      calls.encodes.push({...options, width: this.width, height: this.height});
      return {arrayBuffer: async () => new Uint8Array(jpegBytes(calls.encodes.length)).fill(255).buffer};
    }
  }
  return {
    calls,
    capture: async (windowId, options) => { calls.captures.push([windowId, options.format]); return 'data:image/png;base64,AA=='; },
    globals: {
      OffscreenCanvas,
      fetch: async () => ({blob: async () => ({})}),
      createImageBitmap: async () => ({width: 800, height: 600, close() {}})
    }
  };
}
const crop = {rect: {x: 10, y: 20, width: 100, height: 50}, dpr: 2, width: 1024, height: 768};

test('capture returns a cropped JPEG for preview and stores nothing', async () => {
  const shots = camera();
  const values = {};
  const request = worker(async () => ({ok: true}), values, shots);
  const reply = await request('capture', crop);
  assert.match(reply.image, /^data:image\/jpeg;base64,\/{4}/);
  assert.deepEqual(Object.keys(reply), ['ok', 'image']);
  assert.deepEqual(shots.calls.captures, [[7, 'png']]);
  assert.deepEqual(shots.calls.draws, [[20, 40, 200, 100, 0, 0, 200, 100]]);
  assert.deepEqual(shots.calls.encodes, [{type: 'image/jpeg', quality: 0.8, width: 200, height: 100}]);
  assert.deepEqual(values, {});
});

test('large crops are downscaled and oversized screenshots are dropped', async () => {
  const big = {rect: {x: 0, y: 0, width: 400, height: 300}, dpr: 4, width: 1024, height: 768};
  const shrinking = camera(attempt => attempt === 1 ? 200000 : 2000);
  const request = worker(async () => ({ok: true}), {}, shrinking);
  assert.equal(typeof (await request('capture', big)).image, 'string');
  assert.deepEqual(shrinking.calls.encodes.map(({width, height, quality}) => [width, height, quality]),
    [[800, 600, 0.8], [800, 600, 0.6]]);
  const heavy = worker(async () => ({ok: true}), {}, camera(() => 200000));
  assert.deepEqual(await heavy('capture', crop), {ok: true, image: null});
});

test('a failed capture or an unusable crop box resolves to no image', async () => {
  const failing = worker(async () => ({ok: true}));
  assert.deepEqual(await failing('capture', crop), {ok: true, image: null});
  const shots = camera();
  const request = worker(async () => ({ok: true}), {}, shots);
  const viewport = {width: 1024, height: 768};
  for (const bad of [{rect: {x: -1, y: 0, width: 10, height: 10}, dpr: 2}, {rect: {x: 0, y: 0, width: 0, height: 10}, dpr: 2},
    {rect: {x: 1000, y: 0, width: 100, height: 10}, dpr: 2}, {rect: {x: 0, y: 0, width: 10, height: NaN}, dpr: 2},
    {rect: {x: 0, y: 0, width: 10, height: 10}, dpr: 0}, {rect: {x: 0, y: 0, width: 10, height: 10}}, {rect: null, dpr: 2}, {dpr: 2}]) {
    assert.deepEqual(await request('capture', {...viewport, ...bad}), {ok: true, image: null});
  }
  assert.deepEqual(await request('capture', {rect: crop.rect, dpr: 2}), {ok: true, image: null}); // No viewport.
  assert.equal(shots.calls.captures.length, 0);
});

test('capture only serves the active tab that asked for it', async () => {
  const shots = camera();
  const request = worker(async () => ({ok: true}), {}, shots);
  assert.deepEqual(await request('capture', crop, page, {active: false}), {ok: true, image: null});
  assert.equal(shots.calls.captures.length, 0);

  // The user switched tabs while Chrome was capturing: the picture is of another tab.
  const switched = camera();
  const moved = worker(async () => ({ok: true}), {}, {...switched, stillActive: () => false});
  assert.deepEqual(await moved('capture', crop), {ok: true, image: null});
  assert.equal(switched.calls.captures.length, 1);
  assert.equal(switched.calls.encodes.length, 0);

  const foreign = worker(async () => ({ok: true}), {}, camera());
  const reply = await foreign('capture', {...crop, page: 'https://other.test/'});
  assert.equal(reply.ok, false);
  assert.equal('image' in reply, false);
});

test('capture does not wait behind a send in progress', async () => {
  const slow = heldHelper({ok: true});
  const request = worker(slow.native, {[notesKey]: [note('a')]}, camera());
  const sending = request('send', {ids: ['a'], target});
  await slow.reached;
  let stateArrived = false;
  const queued = request('state').then(() => { stateArrived = true; });
  assert.equal(typeof (await request('capture', crop)).image, 'string');
  assert.equal(stateArrived, false); // Reads of drafts do wait, so they cannot see a half-finished send.
  slow.release();
  await sending;
  await queued;
});

test('a note keeps the screenshot and reference it was saved with and state never returns image bytes', async () => {
  const values = {};
  const request = worker(async () => ({ok: true}), values);
  assert.deepEqual(await request('add', {note: {...note('a'), image: jpeg, reference: pasted}}), {ok: true, shot: true, ref: true});
  assert.deepEqual(await request('add', {note: {...note('b'), image: null}}), {ok: true, shot: false, ref: false});
  assert.deepEqual(await request('add', {note: {...areaNote('c'), reference: pasted}}), {ok: true, shot: false, ref: true});
  assert.deepEqual(values[notesKey][0], {...note('a'), scope: 'element', kind: 'change', image: jpeg, reference: pasted});
  assert.equal('image' in values[notesKey][1], false);
  const state = await request('state');
  assert.deepEqual(state.notes.map(item => [item.id, item.shot, item.ref]), [['a', true, true], ['b', false, false], ['c', false, true]]);
  assert.equal(JSON.stringify(state).includes('data:image'), false);
  assert.equal(state.notes.some(item => 'image' in item || 'reference' in item), false);
  assert.deepEqual(await request('images', {id: 'a'}), {ok: true, image: jpeg, reference: pasted});
  assert.deepEqual(await request('images', {id: 'b'}), {ok: true, image: null, reference: null});
  assert.match((await request('images', {id: 'gone'})).error, /no longer in the list/);
});

test('images must be JPEG data URLs within their size caps', async () => {
  const values = {};
  const request = worker(async () => ({ok: true}), values);
  const body = length => jpeg.slice(0, 23) + 'A'.repeat(length - 23);
  for (const image of ['data:image/png;base64,AAAA', 'https://example.test/a.jpg', jpeg + '<script>', body(180001), 7]) {
    assert.match((await request('add', {note: {...note('a'), image}})).error, /screenshot is not usable/);
  }
  for (const reference of ['data:image/png;base64,AAAA', body(120001), {}]) {
    assert.match((await request('add', {note: {...note('a'), reference}})).error, /smaller reference image/);
  }
  assert.equal(notesKey in values, false);
  assert.equal((await request('add', {note: {...note('a'), image: body(180000), reference: body(120000)}})).ok, true);
});

test('editing can drop the screenshot and set or delete the reference', async () => {
  const values = {[notesKey]: [{...note('a'), image: jpeg}]};
  const request = worker(async () => ({ok: true}), values);
  await request('edit', {id: 'a', comment: 'Keep both', reference: pasted});
  assert.deepEqual(values[notesKey][0], {...note('a'), comment: 'Keep both', image: jpeg, reference: pasted});
  await request('edit', {id: 'a', comment: 'Keep both', shot: false});
  assert.deepEqual(values[notesKey][0], {...note('a'), comment: 'Keep both', reference: pasted});
  assert.match((await request('edit', {id: 'a', comment: 'x', reference: 'data:image/png;base64,AAAA'})).error, /smaller reference image/);
  await request('edit', {id: 'a', comment: 'Plain', reference: null});
  assert.deepEqual(values[notesKey][0], {...note('a'), comment: 'Plain'});
  assert.match((await request('edit', {id: 'gone', comment: 'x'})).error, /no longer in the list/);
});

test('when storage is full a screenshot is dropped but a reference or a note is never lost silently', async () => {
  const full = limit => ({beforeSet(changes) {
    if (JSON.stringify(changes).length > limit) throw new Error('QUOTA_BYTES quota exceeded');
  }});
  const values = {};
  // Room for the note and its reference, but not for the screenshot as well.
  const tight = worker(async () => ({ok: true}), values, full(250));
  assert.deepEqual(await tight('add', {note: {...note('a'), image: jpeg.slice(0, 23) + 'A'.repeat(200)}}), {ok: true, shot: false, ref: false});
  assert.equal('image' in values[notesKey][0], false);

  const none = {};
  const exhausted = worker(async () => ({ok: true}), none, full(0));
  const withReference = await exhausted('add', {note: {...note('a'), image: jpeg, reference: pasted}});
  assert.match(withReference.error, /reference image was not saved/);
  assert.match((await exhausted('add', {note: note('b')})).error, /storage for Nitpost is full/);
  assert.equal(notesKey in none, false);

  const kept = {[notesKey]: [note('a')]};
  const editing = worker(async () => ({ok: true}), kept, full(0));
  assert.match((await editing('edit', {id: 'a', comment: 'x', reference: pasted})).error, /reference image was not saved/);
  assert.deepEqual(kept[notesKey], [note('a')]);
});

test('each scope is validated strictly', async () => {
  const values = {};
  const request = worker(async () => ({ok: true}), values);
  const element = {selector: '#a', text: 'A'};
  const rejected = [
    [{...note('x'), scope: 'page'}, /element, an area or several elements/],
    [{...note('x'), rect: areaNote('x').rect}, /Select the element again/],
    [{...note('x'), elements: groupNote('x').elements}, /Select the element again/],
    [{...note('x'), selector: ''}, /Select the element again/],
    [{...note('x'), width: 0}, /Select the element again/],
    [{...note('x'), height: 1.5}, /Select the element again/],
    [{...areaNote('x'), selector: '#save'}, /Select the area again/],
    [{...areaNote('x'), text: 'Save'}, /Select the area again/],
    [{...areaNote('x'), elements: groupNote('x').elements}, /Select the area again/],
    [{...areaNote('x'), rect: undefined}, /Select the area again/],
    [{...areaNote('x'), rect: {x: -100000001, y: 0, width: 10, height: 10}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0, y: 0, width: -10, height: 10}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0, y: 0, width: 0, height: 10}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0.5, y: 0, width: 10, height: 10}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0, y: 0, width: 10, height: 'tall'}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0, y: 0, width: 10}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0, y: 100000001, width: 10, height: 10}}, /Select the area again/],
    [{...areaNote('x'), rect: {x: 0, y: 0, width: 2e5, height: 10}}, /Select the area again/],
    [{...groupNote('x'), elements: [element]}, /2 to 8 elements/],
    [{...groupNote('x'), elements: Array(9).fill(element)}, /2 to 8 elements/],
    [{...groupNote('x'), elements: [element, {selector: '', text: 'B'}]}, /2 to 8 elements/],
    [{...groupNote('x'), elements: [element, {selector: '#b'}]}, /2 to 8 elements/],
    [{...groupNote('x'), elements: [element, null]}, /2 to 8 elements/],
    [{...groupNote('x'), elements: 'both'}, /2 to 8 elements/],
    [{...groupNote('x'), selector: '#save'}, /2 to 8 elements/],
    [{...groupNote('x'), rect: areaNote('x').rect}, /2 to 8 elements/]
  ];
  for (const [bad, expected] of rejected) {
    const reply = await request('add', {note: bad});
    assert.equal(reply.ok, false, JSON.stringify(bad));
    assert.match(reply.error, expected);
  }
  assert.equal(notesKey in values, false);
  assert.equal((await request('add', {note: {...groupNote('g'), elements: Array(8).fill(element)}})).ok, true);
});

test('an area left of or above the document origin round-trips to the helper request', async () => {
  const calls = [];
  const values = {};
  const request = worker(helper({ok: true, receipt: 'confirmed'}, calls), values);
  const rect = {x: -840, y: -100000000, width: 300, height: 120};
  assert.deepEqual(await request('add', {note: {...areaNote('rtl'), rect}}), {ok: true, shot: false, ref: false});
  assert.deepEqual(values[notesKey][0].rect, rect);
  assert.deepEqual((await request('state')).notes[0].rect, rect);
  assert.equal((await request('send', {ids: ['rtl'], target})).ok, true);
  assert.deepEqual(calls[1].notes, [
    {scope: 'area', kind: 'change', comment: 'Reduce this gap', width: 1024, height: 768, rect}
  ]);
});

test('each scope round-trips to the helper request without borrowing another scope’s fields', async () => {
  const calls = [];
  const values = {};
  const request = worker(helper({ok: true, receipt: 'confirmed'}, calls), values);
  const extra = {elements: [{selector: '#name', text: 'Name', outerHTML: '<input>'}, {selector: '#email', text: 'Email'}]};
  await request('add', {note: {...note('e'), scope: 'element', image: jpeg}});
  await request('add', {note: {...areaNote('a'), kind: 'question', image: jpeg, reference: pasted, stray: true}});
  await request('add', {note: {...groupNote('g'), ...extra, reference: pasted}});
  const state = await request('state');
  assert.deepEqual(state.notes.map(item => item.scope), ['element', 'area', 'group']);
  assert.deepEqual(state.notes[1].rect, areaNote('a').rect);
  assert.deepEqual(state.notes[2].elements, groupNote('g').elements);
  const sent = await request('send', {ids: ['e', 'a', 'g'], target});
  assert.equal(sent.ok, true);
  assert.deepEqual(calls.map(call => call.op), ['capabilities', 'send']);
  const viewport = {width: 1024, height: 768};
  assert.deepEqual(calls[1].notes, [
    {scope: 'element', kind: 'change', comment: 'Align label', ...viewport, selector: '#save', text: 'Save', image: jpeg},
    {scope: 'area', kind: 'question', comment: 'Reduce this gap', ...viewport, rect: areaNote('a').rect, image: jpeg, reference: pasted},
    {scope: 'group', kind: 'change', comment: 'Align these', ...viewport, elements: groupNote('g').elements, reference: pasted}
  ]);
  assert.equal('selector' in calls[1].notes[1] || 'text' in calls[1].notes[1], false);
});

const receipts = [
  ['a confirmed receipt', {ok: true, receipt: 'confirmed', notice: 'Codex accepted the turn.'}, 'confirmed'],
  ['a submitted receipt', {ok: true, receipt: 'submitted', notice: 'Typed into the pane.'}, 'submitted'],
  ['a legacy success', {ok: true}, 'submitted'],
  ['an unconfirmed receipt', {ok: true, receipt: 'unconfirmed', notice: 'Posted to the inbox.'}, 'unconfirmed'],
  ['a legacy keepNotes reply', {ok: true, keepNotes: true}, 'unconfirmed'],
  ['a receipt this version does not know', {ok: true, receipt: 'queued'}, 'unconfirmed'],
  ['an uncertain failure', {ok: false, error: 'The pane closed mid-paste.', uncertain: true}, 'unknown'],
  ['a reply that is not a result', 'garbage', 'unknown'],
  ['a native messaging error during send', new Error('Native host has exited.'), 'unknown'],
  ['a failure from a helper that predates the uncertain flag',
    {ok: false, error: 'Delivery is uncertain. Inspect the Rex prompt before retrying.'}, 'unknown'],
  ['a failure whose uncertain flag is not a boolean', {ok: false, error: 'Odd.', uncertain: 'false'}, 'unknown'],
  ['a definite failure', {ok: false, error: 'That conversation is gone.', uncertain: false}, 'failed'],
  ['a missing helper', new Error('Specified native messaging host not found.'), 'failed'],
  ['a forbidden helper', new Error('Access to the specified native messaging host is forbidden.'), 'failed']
];
for (const [name, reply, status] of receipts) {
  test(name + ' records ' + status, async () => {
    const values = {[notesKey]: [note('a'), note('b'), note('c')]};
    let during;
    const request = worker(async () => {
      during = clone(values[attemptKey]);
      if (reply instanceof Error) throw reply;
      return reply;
    }, values);
    const began = Date.now();
    const sent = await request('send', {ids: ['a', 'c'], target: {...target, project: '/project'}});

    assert.equal(during.status, 'pending'); // Recorded before the helper was called.
    assert.deepEqual(during.ids, ['a', 'c']);
    const delivered = ['confirmed', 'submitted'].includes(status);
    assert.equal(sent.ok, delivered || status === 'unconfirmed');
    assert.equal(sent.attempt.status, status);
    assert.deepEqual(values[attemptKey], sent.attempt);
    assert.deepEqual({...sent.attempt, at: 0, detail: ''}, {
      at: 0, status, ids: ['a', 'c'], count: 2, detail: '',
      target: {label: 'Review', project: '/project', session: 'session:1', block: 'block:1'}
    });
    assert.ok(sent.attempt.at >= began && sent.attempt.at <= Date.now());
    if (sent.ok) {
      assert.equal(sent.receipt, status);
      assert.equal(sent.attempt.detail, reply.notice ?? '');
    } else {
      assert.equal(sent.error, sent.attempt.detail);
      assert.equal('receipt' in sent, false);
    }
    const state = await request('state');
    assert.deepEqual(state.notes.map(item => item.id), delivered ? ['b'] : ['a', 'b', 'c']);
    assert.deepEqual(state.attempt, sent.attempt);
  });
}

test('a missing helper says to install it and an interrupted reply says to check the destination', async () => {
  const send = async failure => {
    const request = worker(async () => { throw new Error(failure); }, {[notesKey]: [note('a')]});
    return request('send', {ids: ['a'], target});
  };
  assert.match((await send('Specified native messaging host not found.')).error, /Install the Nitpost helper/);
  assert.match((await send('Error when communicating with the native messaging host.')).error,
    /did not confirm delivery. Check the destination/);
});

for (const [status, reply] of [['unconfirmed', {ok: true, receipt: 'unconfirmed'}], ['unknown', {ok: false, error: 'Lost', uncertain: true}]]) {
  test('an ' + status + ' batch is not sent again without resend', async () => {
    const calls = [];
    const values = {[notesKey]: [note('a'), note('b')]};
    const request = worker(helper(reply, calls), values);
    const first = await request('send', {ids: ['a'], target});
    assert.equal(first.attempt.status, status);

    for (const ids of [['a'], ['a', 'b'], ['b']]) {
      const again = await request('send', {ids, target});
      assert.equal(again.ok, false);
      assert.match(again.error, /tried to send 1 note from this page to Review on .+ could not confirm.+Check there first/);
      assert.deepEqual(again.attempt, first.attempt);
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(values[attemptKey], first.attempt);
    assert.equal(values[notesKey].length, 2);

    // Send again names the attempt the user was shown.
    for (const stale of [{}, {attempt: first.attempt.at - 1}, {attempt: String(first.attempt.at)}]) {
      const refused = await request('send', {ids: ['a'], target, resend: true, ...stale});
      assert.match(refused.error, /sent again or settled in another tab. Reopen the list/);
      assert.deepEqual(refused.attempt, first.attempt);
    }
    assert.equal(calls.length, 1);
    assert.equal((await request('send', {ids: ['a'], target, resend: 'yes', attempt: first.attempt.at})).ok, false);
    assert.equal(calls.length, 1);
    const resent = await request('send', {ids: ['a'], target, resend: true, attempt: first.attempt.at});
    assert.equal(resent.attempt.status, status);
    assert.ok(resent.attempt.at > first.attempt.at);
    assert.equal(calls.length, 2);

    // A second tab still showing Send again for the first attempt clicks it after this tab did.
    const second = await request('send', {ids: ['a'], target, resend: true, attempt: first.attempt.at});
    assert.equal(second.ok, false);
    assert.match(second.error, /sent again or settled in another tab/);
    assert.deepEqual(second.attempt, resent.attempt);
    assert.equal(calls.length, 2);
  });
}

test('two concurrent sends of a batch without a receipt deliver it once', async () => {
  const calls = [];
  const request = worker(helper({ok: true, receipt: 'unconfirmed', notice: 'Posted.'}, calls), {[notesKey]: [note('a')]});
  const replies = await Promise.all([1, 2, 3].map(() => request('send', {ids: ['a'], target})));
  assert.deepEqual(replies.map(reply => reply.ok), [true, false, false]);
  assert.equal(calls.length, 1);
  assert.equal((await request('state')).notes.length, 1);
});

test('removing every note of an uncertain attempt clears it and unblocks the page', async () => {
  const calls = [];
  const values = {[notesKey]: [note('a'), note('b')]};
  const request = worker(helper({ok: true, receipt: 'unconfirmed'}, calls), values);
  await request('send', {ids: ['a'], target});
  await request('remove', {id: 'b'});
  assert.equal((await request('state')).attempt.status, 'unconfirmed');
  await request('remove', {id: 'a'});
  assert.equal((await request('state')).attempt, null);
  await request('add', {note: note('c')});
  assert.equal((await request('send', {ids: ['c'], target})).ok, true);
  assert.equal(calls.length, 2);
});

test('resolve received removes the attempt’s notes and dismiss keeps them as drafts', async () => {
  const stored = () => ({[notesKey]: [note('a'), note('b'), note('c')]});
  const received = stored();
  const request = worker(helper({ok: true, receipt: 'unconfirmed'}), received);
  const {at} = (await request('send', {ids: ['a', 'c'], target})).attempt;
  assert.match((await request('resolve', {action: 'retry', attempt: at})).error, /whether the notes arrived/);
  for (const stale of [{}, {attempt: at + 1}]) {
    assert.match((await request('resolve', {action: 'received', ...stale})).error, /settled in another tab/);
  }
  assert.equal(received[attemptKey].status, 'unconfirmed');
  assert.equal(received[notesKey].length, 3);
  assert.deepEqual(await request('resolve', {action: 'received', attempt: at}), {ok: true});
  assert.deepEqual(received[notesKey], [note('b')]);
  assert.equal(attemptKey in received, false);
  // A second click, or another tab, has nothing left to resolve.
  assert.match((await request('resolve', {action: 'received', attempt: at})).error, /settled in another tab/);
  assert.deepEqual(received[notesKey], [note('b')]);

  const dismissed = stored();
  const calls = [];
  const again = worker(helper({ok: true, receipt: 'unconfirmed'}, calls), dismissed);
  const shown = (await again('send', {ids: ['a', 'b', 'c'], target})).attempt.at;
  assert.deepEqual(await again('resolve', {action: 'dismiss', attempt: shown}), {ok: true});
  assert.equal(attemptKey in dismissed, false);
  const state = await again('state');
  assert.equal(state.attempt, null);
  assert.equal(state.notes.length, 3);
  assert.equal((await again('send', {ids: ['a'], target})).ok, true); // Ordinary drafts again.
  assert.equal(calls.length, 2);

  const whole = {[notesKey]: [note('a')]};
  const last = worker(helper({ok: false, error: 'Lost', uncertain: true}), whole);
  const lost = (await last('send', {ids: ['a'], target})).attempt.at;
  await last('resolve', {action: 'received', attempt: lost});
  assert.deepEqual(whole, {});
});

test('a stale tab cannot mark a newer batch as received', async () => {
  const values = {[notesKey]: [note('a')]};
  const calls = [];
  const request = worker(helper({ok: true, receipt: 'unconfirmed'}, calls), values);
  // Both tabs show the first attempt.
  const first = (await request('send', {ids: ['a'], target})).attempt;
  // The other tab dismisses it, adds a note and sends both.
  await request('resolve', {action: 'dismiss', attempt: first.at});
  await request('add', {note: note('b')});
  const newer = (await request('send', {ids: ['a', 'b'], target})).attempt;
  assert.ok(newer.at > first.at);

  const stale = await request('resolve', {action: 'received', attempt: first.at});
  assert.equal(stale.ok, false);
  assert.match(stale.error, /sent again or settled in another tab. Reopen the list/);
  assert.equal(values[notesKey].length, 2);
  assert.deepEqual(values[attemptKey], newer);
  assert.match((await request('resolve', {action: 'dismiss', attempt: first.at})).error, /settled in another tab/);
  assert.deepEqual(values[attemptKey], newer);
});

test('attempts made within the same millisecond still get distinct identifiers', async () => {
  const values = {[notesKey]: [note('a')], [attemptKey]: {at: Date.now() + 60000, status: 'failed', ids: ['a'], count: 1, target, detail: ''}};
  const request = worker(helper({ok: true, receipt: 'unconfirmed'}), values);
  const shown = values[attemptKey].at;
  assert.equal((await request('send', {ids: ['a'], target})).attempt.at, shown + 1);
});

test('a send interrupted with the worker leaves a pending record that reads as unknown', async () => {
  const values = {[notesKey]: [note('a')]};
  const calls = [];
  // Chrome stops the worker before its own wait for the helper runs out.
  const dying = worker(msg => { calls.push(msg); return new Promise(() => {}); }, values, clock());
  dying('send', {ids: ['a'], target});
  while (!calls.length) await new Promise(setImmediate);
  assert.equal(values[attemptKey].status, 'pending');

  const delivered = [];
  const restarted = worker(helper({ok: true, receipt: 'confirmed'}, delivered), values);
  const state = await restarted('state');
  assert.equal(state.attempt.status, 'unknown');
  assert.match(state.attempt.detail, /stopped Nitpost before the helper answered/);
  assert.deepEqual(state.attempt.ids, ['a']);
  assert.equal(state.attempt.target.label, 'Review');
  assert.equal(state.notes.length, 1);
  const again = await restarted('send', {ids: ['a'], target});
  assert.equal(again.ok, false);
  assert.match(again.error, /Check there first/);
  assert.equal(delivered.length, 0);
  assert.equal((await restarted('send', {ids: ['a'], target, resend: true, attempt: state.attempt.at})).receipt, 'confirmed');
  assert.equal((await restarted('state')).notes.length, 0);
});

test('notes and attempts stay with the URL the request carried', async () => {
  const other = 'https://example.test/next';
  for (const [receipt, kept] of [['submitted', []], ['unconfirmed', [note('a')]]]) {
    const slow = heldHelper({ok: true, receipt, notice: 'Done.'});
    const values = {[notesKey]: [note('a')], ['notes:' + other]: [note('a'), note('z')]};
    const request = worker(slow.native, values);
    const sending = request('send', {ids: ['a'], target});
    await slow.reached;
    // The tab navigated: the new URL asks for its state while the old URL's reply is outstanding.
    const arrived = request('state', {}, other);
    slow.release();
    assert.equal((await sending).attempt.status, receipt);
    const next = await arrived;
    assert.equal(next.attempt, null);
    assert.deepEqual(next.notes.map(item => item.id), ['a', 'z']);
    assert.deepEqual(values['notes:' + other], [note('a'), note('z')]);
    assert.equal('attempt:' + other in values, false);
    assert.deepEqual(values[notesKey] ?? [], kept);
    assert.equal((await request('state')).attempt.status, receipt);
    // The same note id on the other URL is a different note: it is neither blocked nor resolved.
    const crossed = await request('resolve', {action: 'received', attempt: values[attemptKey].at}, other);
    assert.match(crossed.error, /settled in another tab/);
    assert.equal(values['notes:' + other].length, 2);
    assert.equal(values[attemptKey].status, receipt);
    assert.equal((await request('send', {ids: ['a'], target}, other)).ok, true);
    assert.equal(values[attemptKey].ids.length, 1);
  }
});

test('delivered attempts are forgotten after seven days and uncertain ones are not', async () => {
  const day = 24 * 60 * 60 * 1000;
  const record = (status, age) => ({at: Date.now() - age, status, ids: ['a'], count: 1, target, detail: ''});
  const read = async stored => {
    const values = {[attemptKey]: stored, [notesKey]: [note('a')]};
    const state = await worker(async () => ({ok: true}), values)('state');
    return [state.attempt?.status ?? null, attemptKey in values];
  };
  assert.deepEqual(await read(record('confirmed', 8 * day)), [null, false]);
  assert.deepEqual(await read(record('submitted', 8 * day)), [null, false]);
  assert.deepEqual(await read(record('submitted', 6 * day)), ['submitted', true]);
  assert.deepEqual(await read(record('unconfirmed', 30 * day)), ['unconfirmed', true]);
  assert.deepEqual(await read(record('pending', 30 * day)), ['unknown', true]);
  assert.deepEqual(await read({status: 'sent'}), [null, true]); // Not a record this version wrote.
});

test('screenshots reach a helper that accepts them and are left out for an older helper', async () => {
  const stored = () => ({[notesKey]: [{...note('a'), image: jpeg}, note('b')]});
  const accepted = [];
  const send = worker(async msg => { accepted.push(msg); return {ok: true, shots: true}; }, stored());
  const sent = await send('send', {ids: ['a', 'b'], target});
  assert.deepEqual(accepted.map(msg => msg.op), ['capabilities', 'send']);
  assert.deepEqual(accepted[1].notes.map(item => item.image), [jpeg, undefined]);
  assert.equal(sent.notice, undefined);
  const older = [];
  const legacy = worker(async msg => {
    older.push(msg);
    if (msg.op === 'capabilities') return {ok: false, error: 'Unknown native request.'};
    return {ok: true};
  }, stored());
  const reply = await legacy('send', {ids: ['a', 'b'], target});
  assert.equal(older[1].notes.some(item => 'image' in item), false);
  assert.equal(reply.notice, 'Sent to Review. Screenshots were left out. Update the Nitpost helper to include them.');
  assert.equal(reply.attempt.detail, reply.notice);
});

test('area, group and reference notes need a helper with payload 2', async () => {
  const extended = {area: areaNote('a'), group: groupNote('a'), reference: {...note('a'), reference: pasted}};
  for (const [name, stored] of Object.entries(extended)) {
    for (const capabilities of [{ok: true, shots: true}, {ok: true, shots: true, payload: 1}, {ok: false, error: 'Unknown native request.'}]) {
      const calls = [];
      const values = {[notesKey]: [stored, note('plain')]};
      const request = worker(async msg => { calls.push(msg); return capabilities; }, values);
      const reply = await request('send', {ids: ['a', 'plain'], target});
      assert.equal(reply.ok, false, name);
      assert.match(reply.error, /Update the helper, or use Copy for agent/);
      assert.equal(reply.attempt.status, 'failed');
      assert.deepEqual(calls.map(call => call.op), ['capabilities']);
      assert.equal(values[notesKey].length, 2);
    }
    const calls = [];
    const request = worker(helper({ok: true, receipt: 'confirmed'}, calls), {[notesKey]: [stored]});
    assert.equal((await request('send', {ids: ['a'], target})).ok, true, name);
    assert.deepEqual(calls.map(call => call.op), ['capabilities', 'send']);
  }
  // Plain element notes ask nothing of the helper.
  const calls = [];
  const plain = worker(async msg => { calls.push(msg); return {ok: true}; }, {[notesKey]: [{...note('a'), scope: 'element'}]});
  await plain('send', {ids: ['a'], target});
  assert.deepEqual(calls.map(call => call.op), ['send']);
});

test('a helper that cannot be asked for its capabilities fails the send before delivery', async () => {
  for (const [failure, expected] of [['Specified native messaging host not found.', /Install the Nitpost helper/],
    ['Native host has exited.', /Could not reach the Nitpost helper/]]) {
    const calls = [];
    const values = {[notesKey]: [areaNote('a')]};
    const request = worker(async msg => { calls.push(msg); throw new Error(failure); }, values);
    const reply = await request('send', {ids: ['a'], target});
    assert.match(reply.error, expected);
    assert.equal(reply.attempt.status, 'failed'); // Nothing was handed over, so a retry is safe.
    assert.deepEqual(calls.map(call => call.op), ['capabilities']);
    assert.equal(values[notesKey].length, 1);
  }
});

test('a batch that cannot fit one native frame is refused with what to remove', async () => {
  const heavy = jpeg + 'A'.repeat(400000); // Larger than this version stores, as an earlier build might have.
  const stored = Array.from({length: 45}, (_, index) => ({...note('n' + index), image: heavy}));
  const calls = [];
  const values = {[notesKey]: stored};
  const request = worker(helper({ok: true}, calls), values);
  const reply = await request('send', {ids: stored.map(item => item.id), target});
  assert.equal(reply.ok, false);
  assert.match(reply.error, /too large to send at once.+17\.2 MB.+Remove a reference image or a screenshot/);
  assert.equal(reply.attempt.status, 'failed');
  assert.deepEqual(calls.map(call => call.op), ['capabilities']);
  assert.equal(values[notesKey].length, 45);

  // The largest batch this version can store still fits.
  const body = length => jpeg.slice(0, 23) + 'A'.repeat(length - 23);
  const full = Array.from({length: 50}, (_, index) => ({...note('n' + index), image: body(180000), reference: body(120000)}));
  const sent = [];
  const fits = worker(helper({ok: true}, sent), {[notesKey]: full});
  assert.equal((await fits('send', {ids: full.map(item => item.id), target})).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(sent[1])) < 16 * 1024 * 1024);
});

test('a send that cannot be recorded is not sent', async () => {
  const calls = [];
  const values = {[notesKey]: [note('a')]};
  const request = worker(helper({ok: true}, calls), values, {beforeSet() { throw new Error('QUOTA_BYTES quota exceeded'); }});
  const reply = await request('send', {ids: ['a'], target});
  assert.deepEqual(reply, {
    ok: false, attempt: null,
    error: 'Nothing was sent. Chrome’s storage for Nitpost is full. Remove notes or screenshots you no longer need, or use Copy for agent.'
  });
  assert.equal(calls.length, 0);
  assert.equal(values[notesKey].length, 1);
});

test('a storage failure that is not about space is not reported as a full store', async () => {
  const values = {[notesKey]: [note('a')]};
  const calls = [];
  const request = worker(helper({ok: true}, calls), values, {beforeSet() { throw new Error('IO error: database is locked.'); }});
  const replies = [
    await request('add', {note: {...note('b'), image: jpeg, reference: pasted}}),
    await request('edit', {id: 'a', comment: 'x', reference: pasted}),
    await request('send', {ids: ['a'], target})
  ];
  for (const reply of replies) {
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Chrome could not save this: IO error: database is locked\. Try again\./);
    assert.doesNotMatch(reply.error, /full/);
  }
  assert.match(replies[2].error, /^Nothing was sent\. /);
  assert.equal(calls.length, 0);
  assert.deepEqual(values, {[notesKey]: [note('a')]});
});

test('delivered attempts for pages never reopened are swept when the worker starts', async () => {
  const day = 24 * 60 * 60 * 1000;
  const record = (status, age) => ({at: Date.now() - age, status, ids: ['a'], count: 1, target, detail: ''});
  const values = {
    'attempt:https://a.test/': record('confirmed', 8 * day),
    'attempt:https://b.test/': record('submitted', 30 * day),
    'attempt:https://c.test/': record('submitted', 6 * day),
    'attempt:https://d.test/': record('unconfirmed', 30 * day),
    'attempt:https://e.test/': record('unknown', 30 * day),
    'attempt:https://f.test/': record('pending', 30 * day),
    'attempt:https://g.test/': record('failed', 30 * day),
    'notes:https://a.test/': [{...note('kept'), image: jpeg}],
    'lastDestination': {project: null, target}
  };
  const browser = {reads: []};
  const request = worker(async () => ({ok: true}), values, browser);
  await request('dim', {on: true}); // Queued behind the sweep.
  assert.deepEqual(Object.keys(values).filter(key => key.startsWith('attempt:')).map(key => key.slice(16, 17)),
    ['c', 'd', 'e', 'f', 'g']);
  assert.equal(values['notes:https://a.test/'].length, 1);
  assert.equal(values['attempt:https://f.test/'].status, 'pending');
  assert.equal(browser.reads.length, 1); // One read, of attempt records only: drafts and their images stay on disk.
  assert.equal(browser.reads[0].every(key => key.startsWith('attempt:')), true);

  const empty = {reads: []};
  await worker(async () => ({ok: true}), {[notesKey]: [note('a')]}, empty)('dim', {on: true});
  assert.deepEqual(empty.reads, []);
});

test('a start keeps the project path the helper resolved', async () => {
  const asked = '/Users/test/link';
  const resolved = '/Volumes/Work/project';
  const created = {...target, project: resolved};
  const calls = [];
  const values = {[notesKey]: [note('a')]};
  const request = worker(async msg => { calls.push(msg); return {ok: true, receipt: 'submitted', notice: 'Started.', target: created}; }, values);
  const sent = await request('send', {ids: ['a'], target: {agent: 'claude', project: asked}});
  assert.equal(sent.ok, true);
  assert.equal(sent.receipt, 'submitted');
  assert.equal(calls[0].project, asked);
  assert.deepEqual(sent.target, created);
  assert.equal(sent.attempt.status, 'submitted');
  assert.equal(sent.attempt.target.project, resolved);
  const state = await request('state');
  assert.equal(state.notes.length, 0);
  assert.equal(state.project, resolved);
  assert.deepEqual(state.target, created);
  assert.equal(state.recentProjects[0], resolved);
  // The saved destination is usable as it stands for the next send.
  await request('add', {note: note('b')});
  assert.equal((await request('send', {ids: ['b'], target: state.target})).ok, true);
  assert.equal(calls[1].project, resolved);

  const bad = worker(async () => ({ok: true, receipt: 'submitted', target: {...target, project: 'relative/path'}}), {[notesKey]: [note('a')]});
  assert.equal((await bad('send', {ids: ['a'], target: {agent: 'claude', project: asked}})).attempt.status, 'unknown');
});

test('a delivered batch whose result cannot be saved stays unknown and cannot be repeated unnoticed', async () => {
  const calls = [];
  const values = {[notesKey]: [note('a')]};
  let writes = 0;
  const request = worker(helper({ok: true, receipt: 'confirmed'}, calls), values, {beforeSet() {
    writes += 1;
    if (writes === 2) throw new Error('QUOTA_BYTES quota exceeded');
  }});
  const reply = await request('send', {ids: ['a'], target});
  assert.equal(reply.ok, false);
  assert.match(reply.error, /accepted the batch, but Chrome could not save the result/);
  assert.equal(reply.attempt.status, 'unknown');
  assert.equal(values[attemptKey].status, 'pending');
  assert.equal(values[notesKey].length, 1);
  assert.match((await request('send', {ids: ['a'], target})).error, /Check there first/);
  assert.equal(calls.length, 1);
});

test('targets reports the helper connection as a state and passes checks through', async () => {
  const checks = [{route: 'claude', found: 2, eligible: 0, detail: 'Two Claude Code sessions are open but none has a peer inbox.'}];
  const starts = [{agent: 'codex'}];
  const connected = worker(async msg => {
    assert.deepEqual(msg, {op: 'targets'});
    return {ok: true, targets: [target], starts, checks};
  });
  assert.deepEqual(await connected('targets'), {ok: true, connection: 'connected', targets: [target], starts, checks});
  const older = worker(async () => ({ok: true, targets: [target], starts}));
  assert.deepEqual((await older('targets')).checks, []);

  const empty = {targets: [], starts: [], checks: []};
  const failing = failure => worker(async () => {
    if (failure instanceof Error) throw failure;
    return failure;
  })('targets');
  for (const failure of ['Specified native messaging host not found.', 'Access to the specified native messaging host is forbidden.']) {
    assert.deepEqual(await failing(new Error(failure)),
      {ok: true, connection: 'missing', ...empty, error: 'Install the Nitpost helper on your Mac, then try again.'});
  }
  assert.deepEqual(await failing(new Error('Native host has exited.')), {
    ok: true, connection: 'unreachable', ...empty,
    error: 'Could not reach the Nitpost helper. Check the installation and refresh destinations.'
  });
  // The helper ran and refused: that is its own message to show, not a connection problem.
  assert.deepEqual(await failing({ok: false, error: 'Too many destinations.'}),
    {ok: true, connection: 'error', ...empty, error: 'Too many destinations.'});
  for (const useless of [undefined, 'garbage', {}, {ok: 'yes'}]) {
    assert.deepEqual(await failing(useless), {
      ok: true, connection: 'unreachable', ...empty, error: 'The companion returned an unexpected response.'
    });
  }
});

test('discovery does not wait behind a send in progress', async () => {
  const slow = heldHelper({ok: true});
  const request = worker(async msg => msg.op === 'targets' ? {ok: true, targets: [], starts: []} : slow.native(msg),
    {[notesKey]: [note('a')]});
  const sending = request('send', {ids: ['a'], target});
  await slow.reached;
  assert.equal((await request('targets')).connection, 'connected');
  slow.release();
  await sending;
});

test('state and the toolbar title name the shortcut Chrome assigned', async () => {
  const assigned = {shortcut: '⌥⇧P', titles: []};
  const request = worker(async () => ({ok: true}), {}, assigned);
  assert.equal((await request('state')).shortcut, '⌥⇧P');
  assert.deepEqual(assigned.titles, [{title: 'Annotate this page with Nitpost (⌥⇧P)'}]);
  await assigned.clicked({id: 3, url: page});
  assert.deepEqual(assigned.titles[1], {tabId: 3, title: 'Annotate this page with Nitpost (⌥⇧P)'});

  const unset = {titles: []};
  const plain = worker(async () => ({ok: true}), {}, unset);
  assert.equal((await plain('state')).shortcut, '');
  assert.deepEqual(unset.titles, [{title: 'Annotate this page with Nitpost'}]);
});

test('unknown actions and foreign senders are refused', async () => {
  const request = worker(async () => ({ok: true}));
  for (const op of ['snapshot', 'constructor', 'toString', undefined]) {
    assert.equal((await request(op)).error, 'Unknown annotation action.');
  }
  assert.equal((await request('state', {page: 'https://other.test/'})).error, 'Reload the page to annotate it.');
});

test('a helper that never answers a send is given up on, recorded as unknown, and stops blocking other tabs', async () => {
  const time = clock();
  const other = 'https://other.test/';
  const values = {[notesKey]: [note('a')]};
  const calls = [];
  const answers = [];
  const request = worker(msg => {
    calls.push(msg);
    return new Promise(resolve => answers.push(resolve));
  }, values, time);
  let sent;
  request('send', {ids: ['a'], target}).then(reply => { sent = reply; });
  let state;
  request('state', {}, other).then(reply => { state = reply; });
  let added;
  request('add', {note: note('x')}, other).then(reply => { added = reply; });
  await time.advance(0); // The send reaches the helper.
  await time.advance(119999);
  assert.equal(calls.length, 1);
  assert.equal(sent, undefined);
  assert.equal(state, undefined); // Still queued behind the send.

  await time.advance(1);
  assert.equal(sent.ok, false);
  assert.equal(sent.attempt.status, 'unknown');
  assert.equal(sent.error, 'The Nitpost helper did not answer within 2 minutes. The batch may or may not have arrived. '
    + 'Check the destination before sending again.');
  assert.deepEqual(values[attemptKey], sent.attempt);
  assert.equal(values[notesKey].length, 1);
  assert.equal(state.ok, true);
  assert.deepEqual(added, {ok: true, shot: false, ref: false});
  assert.deepEqual(time.waiting(), []);

  // The batch cannot go out again unnoticed, and the user's resend makes a newer record.
  assert.match((await request('send', {ids: ['a'], target})).error, /Check there first/);
  let resent;
  request('send', {ids: ['a'], target, resend: true, attempt: sent.attempt.at}).then(reply => { resent = reply; });
  await time.advance(0);
  assert.equal(calls.length, 2);
  answers[1]({ok: true, receipt: 'unconfirmed', notice: 'Posted.'});
  await time.advance(0);
  assert.equal(resent.attempt.status, 'unconfirmed');

  // The first call answers at last, with a success. Nothing listens any more.
  answers[0]({ok: true, receipt: 'confirmed', notice: 'Late.'});
  await time.advance(0);
  assert.deepEqual(values[attemptKey], resent.attempt);
  assert.deepEqual(values[notesKey], [note('a')]);
  assert.equal((await request('state')).attempt.status, 'unconfirmed');
});

test('a late failure or a late success after the wait ran out changes nothing', async () => {
  for (const late of [{ok: true, receipt: 'confirmed'}, {ok: false, error: 'Gone.', uncertain: false}, new Error('Native host has exited.')]) {
    const time = clock();
    const values = {[notesKey]: [note('a'), note('b')]};
    let answer;
    const request = worker(() => new Promise((resolve, reject) => {
      answer = () => late instanceof Error ? reject(late) : resolve(late);
    }), values, time);
    let sent;
    request('send', {ids: ['a'], target: {agent: 'codex', project: '/project'}}).then(reply => { sent = reply; });
    await time.advance(0);
    await time.advance(120000);
    assert.equal(sent.attempt.status, 'unknown');
    const stored = clone(values);
    answer();
    await time.advance(0);
    assert.deepEqual(values, stored);
    assert.equal(values[notesKey].length, 2);
    assert.equal('lastDestination' in values, false);
  }
});

test('a helper that never answers the capability check fails the send without delivering', async () => {
  const time = clock();
  const calls = [];
  const values = {[notesKey]: [areaNote('a')]};
  const request = worker(msg => { calls.push(msg.op); return new Promise(() => {}); }, values, time);
  let sent;
  request('send', {ids: ['a'], target}).then(reply => { sent = reply; });
  await time.advance(0);
  await time.advance(9999);
  assert.equal(sent, undefined);
  await time.advance(1);
  assert.equal(sent.attempt.status, 'failed'); // Nothing was handed over.
  assert.equal(sent.error, 'The Nitpost helper did not answer within 10 seconds.');
  assert.deepEqual(calls, ['capabilities']);
  assert.equal((await request('state')).notes.length, 1);
});

test('a helper that never answers targets is reported as unreachable, and choosing a folder is not timed', async () => {
  const time = clock();
  const request = worker(() => new Promise(() => {}), {}, time);
  let found;
  request('targets').then(reply => { found = reply; });
  let folder;
  request('chooseFolder').then(reply => { folder = reply; });
  await time.advance(0);
  await time.advance(29999);
  assert.equal(found, undefined);
  await time.advance(1);
  assert.deepEqual(found, {
    ok: true, connection: 'unreachable', targets: [], starts: [], checks: [],
    error: 'The Nitpost helper did not answer within 30 seconds. Refresh destinations to try again.'
  });
  await time.advance(3600000);
  assert.equal(folder, undefined); // A person is choosing.
  assert.deepEqual(time.waiting(), []);
});

test('an answer in time cancels the wait', async () => {
  const time = clock();
  const request = worker(helper({ok: true, receipt: 'confirmed'}), {[notesKey]: [{...note('a'), image: jpeg}]}, time);
  assert.equal((await request('send', {ids: ['a'], target})).receipt, 'confirmed');
  assert.equal((await request('targets')).connection, 'connected');
  assert.deepEqual(time.waiting(), []);
});

test('editing can clear the stored excerpt but never rewrite it', async () => {
  const legacy = {...note('old'), image: jpeg};
  const values = {[notesKey]: [legacy]};
  const calls = [];
  const request = worker(helper({ok: true, receipt: 'confirmed'}, calls), values);
  await request('add', {note: {...note('e'), scope: 'element'}});
  await request('add', {note: groupNote('g')});
  await request('add', {note: areaNote('a')});
  const before = clone(values[notesKey]);

  for (const text of ['Reworded', ' ', null, false, 0, ['']]) {
    for (const id of ['old', 'e', 'g']) {
      assert.equal((await request('edit', {id, comment: 'x', text})).error, 'An excerpt can be removed but not rewritten.');
    }
  }
  assert.equal((await request('edit', {id: 'a', comment: 'x', text: ''})).error, 'An area note has no excerpt to remove.');
  assert.deepEqual(values[notesKey], before);

  // Leaving text out keeps the excerpt.
  await request('edit', {id: 'e', comment: 'Align label'});
  assert.equal(values[notesKey][1].text, 'Save');

  for (const id of ['old', 'e', 'g']) {
    assert.deepEqual(await request('edit', {id, comment: 'Cleared', text: ''}), {ok: true});
  }
  assert.deepEqual(values[notesKey][0], {...legacy, comment: 'Cleared', text: ''});
  assert.deepEqual(values[notesKey][1], {...before[1], comment: 'Cleared', text: ''});
  assert.deepEqual(values[notesKey][2], {...before[2], comment: 'Cleared',
    elements: [{selector: '#name', text: ''}, {selector: '#email', text: ''}]});
  assert.equal('text' in values[notesKey][2], false);
  assert.deepEqual(values[notesKey][3], before[3]);
  assert.deepEqual((await request('state')).notes.map(item => item.text), ['', '', undefined, undefined]);

  assert.equal((await request('send', {ids: ['old', 'e', 'g', 'a'], target})).ok, true);
  const sent = calls.at(-1).notes;
  assert.deepEqual(sent.map(item => item.text), ['', '', undefined, undefined]);
  assert.deepEqual(sent[2].elements, [{selector: '#name', text: ''}, {selector: '#email', text: ''}]);
  const wire = JSON.stringify(sent);
  for (const excerpt of ['Save', 'Name', 'Email']) assert.equal(wire.includes('"' + excerpt + '"'), false);
  assert.equal(sent[0].selector, '#save'); // Only the excerpt goes: the selector still identifies the element.
});

test('every worker start points Chrome at the uninstall page for the installed version', () => {
  const urls = [];
  worker(async () => current, {}, {setUninstallURL: async url => { urls.push(url); }});
  assert.deepEqual(urls, ['https://lolabradora.github.io/nitpost/uninstalled.html?v=0.3.0-beta.2']);
  worker(async () => current, {}, {manifest: {version: '0.4.0'}, setUninstallURL: async url => { urls.push(url); }});
  assert.equal(urls[1], 'https://lolabradora.github.io/nitpost/uninstalled.html?v=0.4.0');
});

test('an uninstall page Chrome refuses is logged and leaves the worker running', async () => {
  const warnings = [];
  const request = worker(async () => current, {}, {
    setUninstallURL: async () => { throw new Error('Invalid URL'); },
    globals: {console: {warn: (...args) => warnings.push(args)}}
  });
  assert.equal((await request('state')).ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /uninstall/);
  assert.equal(warnings[0][1].message, 'Invalid URL');
});

const reportHead = '- Nitpost: 0.3.0-beta.2\n- Browser: Chrome 151 on macOS\n';
const reportFoot = '\n\n## What happened\n\n';

// What a report says, read back from the one address the worker opened.
function reportOf(opened) {
  assert.equal(opened.length, 1);
  assert.deepEqual(Object.keys(opened[0]), ['url']);
  const url = new URL(opened[0].url);
  assert.equal(url.origin + url.pathname, 'https://github.com/lolabradora/nitpost/issues/new');
  assert.deepEqual([...url.searchParams.keys()], ['title', 'body']);
  return {href: url.href, title: url.searchParams.get('title'), body: url.searchParams.get('body')};
}

test('a problem report lists versions and the helper state, then leaves room to write', async () => {
  const opened = [];
  const request = worker(async () => current, {}, {opened});
  assert.deepEqual(await request('report', {connection: 'connected'}), {ok: true});
  const report = reportOf(opened);
  assert.equal(report.title, 'Problem with Nitpost 0.3.0-beta.2');
  assert.equal(report.body, reportHead + '- Helper: connected' + reportFoot);
});

test('a problem report after a failed send carries nothing from the page, the notes or the destination', async () => {
  const opened = [];
  const secret = 'https://intranet.example.test/billing/invoices?customer=4411#q3';
  const failure = 'No pane at /Users/sam/clients/acme-rebrand for conversation Acme pricing review';
  const request = worker(helper({ok: false, error: failure, uncertain: false}), {}, {opened});
  const add = fields => request('add', {note: fields}, secret);
  await add({...note('a'), selector: '#invoice-total > span.amount', text: 'Total due 9,120 EUR',
    comment: 'Hide the discount row', image: jpeg, reference: pasted});
  await add({...groupNote('g'), comment: 'Tighten these two fields'});
  await add({...areaNote('r'), comment: 'Margin under the header'});
  const destination = {session: 'session:6f1c2a', block: 'block:9d7e41', label: 'Acme pricing review',
    identity: 'codex:5512', project: '/Users/sam/clients/acme-rebrand'};
  const sent = await request('send', {ids: ['a', 'g', 'r'], target: destination}, secret);
  assert.equal(sent.attempt.status, 'failed');
  assert.equal(sent.attempt.detail, failure);
  assert.equal((await request('state', {}, secret)).notes.length, 3);

  assert.equal((await request('report', {connection: 'error'}, secret)).ok, true);
  const report = reportOf(opened);
  assert.equal(report.body, reportHead + '- Helper: error\n- Last send: failed, Rex' + reportFoot);
  const text = report.href + decodeURIComponent(report.href.replaceAll('+', ' '));
  const leaks = ['intranet', 'billing', 'invoices', 'customer', '4411', 'q3', 'invoice-total', 'span.amount',
    '#name', '#email', 'Total due', '9,120', 'Name', 'Email', 'discount', 'Tighten', 'Margin', '2400',
    '/Users', 'sam', 'clients', 'acme', 'Acme', 'pricing', '6f1c2a', '9d7e41', '5512', 'No pane',
    '/9j/', 'data:image', 'base64'];
  for (const leak of leaks) assert.equal(text.includes(leak), false, leak);
  assert.ok(report.href.length < 600, String(report.href.length));
});

test('a problem report quotes a failure only when the wording is the extension’s own', async () => {
  const opened = [];
  const request = worker(async () => { throw new Error('Specified native messaging host not found.'); }, {}, {opened});
  await request('add', {note: {...note('a'), image: jpeg}});
  const sent = await request('send', {ids: ['a'], target: {agent: 'codex', project: '/work/site'}});
  assert.equal(sent.attempt.status, 'failed');
  await request('report', {connection: 'missing'});
  assert.equal(reportOf(opened).body, reportHead + '- Helper: missing\n- Last send: failed, new Rex session\n'
    + '- Last send message: Install the Nitpost helper on your Mac, then try again.' + reportFoot);
});

test('a problem report names the kind of destination and never its session', async () => {
  const kinds = {'claude-inbox': 'Claude Code inbox', 'codex-server': 'Codex thread', tmux: 'tmux',
    'session:abc': 'Rex', 'fake-session': 'other', constructor: 'other'};
  for (const [session, kind] of Object.entries(kinds)) {
    const opened = [];
    const record = {at: Date.now(), status: 'unconfirmed', ids: ['a'], count: 1, detail: 'Posted to /work/site.',
      target: {label: 'Review', project: '/work/site', session, block: 'b:1'}};
    const request = worker(async () => current, {[attemptKey]: record}, {opened});
    await request('report', {connection: 'connected'});
    assert.equal(reportOf(opened).body,
      reportHead + '- Helper: connected\n- Last send: unconfirmed, ' + kind + reportFoot);
  }
});

test('the tab cannot choose where a problem report opens or what it says', async () => {
  const opened = [];
  const request = worker(async () => current, {}, {opened});
  const planted = {url: 'https://evil.example/', title: 'planted', body: 'planted', attempt: {status: 'planted'}};
  assert.equal((await request('report', {connection: 'unchecked', ...planted})).ok, true);
  const report = reportOf(opened);
  assert.equal(report.body, reportHead + '- Helper: unchecked' + reportFoot);
  assert.equal(report.href.includes('planted') || report.href.includes('evil'), false);

  for (const connection of [undefined, 'https://evil.example/', 'connected\n- Page: /secret', ['missing'], '']) {
    const refused = await request('report', {connection});
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Reopen the list/);
  }
  assert.equal(opened.length, 1);
});

test('a problem report Chrome could not open says so', async () => {
  const request = worker(async () => current, {}, {create: async () => { throw new Error('No current window'); }});
  assert.deepEqual(await request('report', {connection: 'connected'}), {ok: false, error: 'No current window'});
});
