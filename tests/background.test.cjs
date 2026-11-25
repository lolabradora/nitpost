const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../extension/background.js'), 'utf8');

function worker(native, values = {}) {
  let listener;
  const chrome = {
    action: {onClicked: {addListener() {}}},
    runtime: {
      id: 'paneparcel', sendNativeMessage: (_, request) => native(request),
      onMessage: {addListener(callback) { listener = callback; }}
    },
    storage: {local: {
      get: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
      set: async changes => Object.assign(values, changes),
      remove: async key => { delete values[key]; }
    }}
  };
  vm.runInNewContext(source, {chrome, URL});
  return (op, fields = {}, page = 'https://example.test/p') => new Promise(resolve => {
    listener({op, page, ...fields}, {id: 'paneparcel', frameId: 0, tab: {}, url: page}, resolve);
  });
}

const target = {block: 'block:1', session: 'session:1', label: 'Review'};
function note(id) {
  return {id, selector: '#save', text: 'Save', comment: 'Align label', width: 1024, height: 768};
}

test('concurrent tabs preserve additions and can send a selected batch only once', async () => {
  const deliveries = [];
  const request = worker(async msg => { deliveries.push(msg); return {ok: true}; });
  await Promise.all(['a', 'b'].map(id => request('add', {note: note(id)})));
  const responses = await Promise.all([1, 2].map(() => request('send', {ids: ['a'], target})));
  assert.deepEqual(responses.map(r => r.ok), [true, false]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].notes.length, 1);
  assert.equal((await request('state')).notes[0].id, 'b');
});

test('bridge failure preserves notes and successful retry clears the batch', async () => {
  let online = false;
  const request = worker(async () => online ? {ok: true} : {ok: false, error: 'Agent closed'});
  await request('add', {note: note('a')});
  const send = () => request('send', {ids: ['a'], target});
  assert.equal((await send()).error, 'Agent closed');
  assert.equal((await request('state')).notes.length, 1);
  online = true;
  assert.equal((await send()).ok, true);
  assert.equal((await request('state')).notes.length, 0);
});

test('drafts belong to a URL and the preferred destination belongs to its origin', async () => {
  const request = worker();
  await request('add', {note: note('a')});
  await request('select', {target});
  const elsewhere = await request('state', {}, 'https://example.test/other');
  assert.equal(elsewhere.notes.length, 0);
  assert.equal(elsewhere.target.block, target.block);
  assert.equal((await request('state', {}, 'https://other.test/')).target, null);
});

test('a GitHub repository remembers its project across routes independently of other repositories', async () => {
  const request = worker(undefined, {'target:https://github.com': target});
  const repo = 'https://github.com/Sureshot-Labs/starter';
  const project = '/Users/test/dev/starter';
  assert.equal((await request('state', {}, repo)).target, null);
  await request('select', {project, target: null}, repo);
  assert.equal((await request('state', {}, repo.toLowerCase() + '/pull/12')).project, project);
  const other = await request('state', {}, 'https://github.com/Sureshot-Labs/example');
  assert.equal(other.project, null);
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
});

for (const agent of ['codex', 'claude']) {
  test('start ' + agent + ' on submit and route future notes to the created conversation', async () => {
    const project = '/Users/test/Project with spaces';
    const created = {...target, project};
    const calls = [];
    const request = worker(async msg => {
      calls.push(msg);
      return {ok: true, target: created};
    });
    const start = {agent, project};
    await request('select', {project, target: start});
    await request('add', {note: note('first')});
    assert.equal(calls.length, 0);
    const result = await request('send', {ids: ['first'], target: start});
    assert.equal(result.target.block, created.block);
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

test('failed start keeps notes and cancelled folder choice leaves saved preferences intact', async () => {
  const project = '/project';
  const start = {project, agent: 'claude'};
  const request = worker(async msg => msg.op === 'chooseFolder'
    ? {ok: true, project: null} : {ok: false, error: 'Claude Code unavailable'});
  await request('select', {project, target: start});
  assert.equal((await request('chooseFolder')).project, null);
  await request('add', {note: note('a')});
  assert.equal((await request('send', {target: start, ids: ['a']})).ok, false);
  const state = await request('state');
  assert.equal(state.notes.length, 1);
  assert.equal(state.project, project);
  assert.equal(state.target.agent, 'claude');
});

test('focus uses the resolved pane after starting and recording delivery', async () => {
  const project = '/test';
  const created = {...target, project};
  const operations = [];
  const values = {};
  const request = worker(async msg => {
    operations.push(msg.op);
    if (msg.op === 'start') return {ok: true, target: created};
    assert.equal(msg.session, created.session);
    assert.equal(msg.block, created.block);
    assert.equal(values['notes:https://example.test/p'], undefined);
    return {ok: true};
  }, values);
  await request('add', {note: note('a')});
  const result = await request('send', {ids: ['a'], target: {project, agent: 'codex'}, focus: true});
  assert.equal(result.focusFailed, undefined);
  assert.deepEqual(operations, ['start', 'focus']);
});

test('failure to focus leaves a confirmed delivery and cannot resend the same batch', async () => {
  const operations = [];
  const request = worker(async msg => {
    operations.push(msg.op);
    return msg.op === 'focus' ? {ok: false, error: 'Rex unavailable'} : {ok: true};
  });
  await request('add', {note: note('a')});
  const send = () => request('send', {ids: ['a'], target, focus: true});
  const result = await send();
  assert.equal(result.ok, true);
  assert.equal(result.focusFailed, true);
  assert.equal((await send()).ok, false);
  assert.deepEqual(operations, ['send', 'focus']);
});

test('local files keep notes per URL and destinations per folder', async () => {
  const sent = [];
  const request = worker(async message => { sent.push(message); return {ok: true}; });
  const page = 'file:///Users/test/site/index.html';
  await request('add', {note: note('a')}, page);
  await request('select', {target}, page);
  const sibling = await request('state', {}, 'file:///Users/test/site/about.html');
  assert.equal(sibling.target.block, target.block);
  assert.equal(sibling.notes.length, 0);
  assert.equal((await request('state', {}, 'file:///Users/test/other/index.html')).target, null);
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
  assert.deepEqual(calls.map(c => c.op), ['send']);
  assert.equal(calls[0].block, inbox.block);
  assert.equal((await request('state')).target.focusable, false);
  assert.equal((await request('state')).notes.length, 1);
});
