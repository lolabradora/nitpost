const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../docs/signals.js'), 'utf8');

// Loads docs/signals.js as the page at `address` would, then stands in for count.js by
// recording what the page asks it to count.
function load(address, page) {
  const url = new URL(address);
  const sent = [];
  const scripts = [];
  const listeners = {};
  const location = {
    protocol: url.protocol, hostname: url.hostname, pathname: url.pathname,
    search: url.search, hash: url.hash,
  };
  const window = {};
  const context = {
    window,
    location,
    URLSearchParams,
    history: {
      replaceState(state, title, next) {
        const replaced = new URL(next, url);
        Object.assign(location, {search: replaced.search, hash: replaced.hash});
      },
    },
    document: {
      currentScript: {dataset: page ? {page} : {}},
      createElement: () => ({}),
      head: {append: script => scripts.push(script)},
      addEventListener: (type, listener) => { listeners[type] = listener; },
    },
  };
  vm.runInNewContext(source, context);
  const settings = window.goatcounter;
  if (settings) settings.count = hit => sent.push({...hit});
  return {window, location, settings, scripts, sent, listeners, signals: window.nitpostSignals};
}

const site = 'https://lolabradora.github.io/nitpost/';

test('a page is counted by its path at the one configured endpoint', () => {
  const page = load(site + 'docs.html?utm_source=x&draft=secret#install');
  assert.equal(page.settings.endpoint, 'https://nitpost.goatcounter.com/count');
  assert.equal(page.settings.path, '/nitpost/docs.html');
  assert.equal(page.scripts.length, 1);
  assert.match(page.scripts[0].src, /^https:\/\/gc\.zgo\.at\/count\.v\d+\.js$/);
  assert.match(page.scripts[0].integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.equal(page.scripts[0].crossOrigin, 'anonymous');
});

test('local pages load no counter and counting does nothing', () => {
  for (const address of ['http://localhost:8000/index.html', 'http://127.0.0.1:8000/',
    'http://[::1]:8000/', 'file:///Users/someone/nitpost/docs/index.html']) {
    const page = load(address);
    assert.equal(page.settings, undefined, address);
    assert.equal(page.scripts.length, 0, address);
    assert.doesNotThrow(() => page.signals.count('copy-install-command'));
  }
});

test('the uninstall page is counted under a validated version', () => {
  const valid = ['0.3.0-beta.2', '1.0.0', '12.34.56-rc.1'];
  for (const version of valid) {
    const page = load(site + 'uninstalled.html?v=' + version, 'uninstalled');
    assert.equal(page.settings.path, '/nitpost/uninstalled/' + version);
    assert.equal(page.location.search, '?v=' + version);
  }
});

test('an invalid version is dropped from the path and from the address', () => {
  const invalid = ['', '<script>alert(1)</script>', '1.2', '1.2.3.4', '0.3.0-BETA.2', '0.3.0-beta',
    '0.3.0-beta.2\nx', ' 0.3.0', '9'.repeat(5000), '11111.0.0', '1.0.0-' + 'a'.repeat(13) + '.1',
    '../../x', '1.0.0/evil'];
  for (const version of invalid) {
    const address = site + 'uninstalled.html?v=' + encodeURIComponent(version) + '#top';
    const page = load(address, 'uninstalled');
    assert.equal(page.settings.path, '/nitpost/uninstalled', version.slice(0, 40));
    assert.equal(page.location.search, '');
    assert.equal(page.location.hash, '#top');
    page.signals.countReason('other');
    assert.equal(page.sent[0].referrer, '');
  }
});

test('other parameters beside a valid version are removed from the address', () => {
  const page = load(site + 'uninstalled.html?v=0.3.0-beta.2&email=a%40b.c', 'uninstalled');
  assert.equal(page.location.search, '?v=0.3.0-beta.2');
  assert.equal(page.settings.path, '/nitpost/uninstalled/0.3.0-beta.2');
});

test('the version is read on the uninstall page only', () => {
  const page = load(site + 'docs.html?v=0.3.0-beta.2');
  assert.equal(page.settings.path, '/nitpost/docs.html');
  assert.equal(page.location.search, '?v=0.3.0-beta.2');
});

test('only the named events are sent, each as an event with a fixed title', () => {
  const page = load(site);
  const names = ['copy-install-command', 'copy-skill-command', 'open-releases', 'open-github',
    'open-privacy'];
  for (const name of names) page.signals.count(name);
  for (const name of [undefined, '', 'toString', 'constructor', 'open-something', 'Copy']) {
    page.signals.count(name);
  }
  assert.deepEqual(page.sent.map(hit => hit.path), names);
  for (const hit of page.sent) {
    assert.equal(hit.event, true);
    assert.equal(hit.referrer, '');
    assert.match(hit.title, /^(Copy|Open) [A-Za-z ]+$/);
  }
});

test('a reason is sent as uninstall-reason-<slug> with the version as referrer', () => {
  const slugs = ['helper-install', 'no-conversation', 'send-failed', 'missing-feature',
    'just-trying', 'other'];
  const page = load(site + 'uninstalled.html?v=0.3.0-beta.2', 'uninstalled');
  for (const slug of slugs) page.signals.countReason(slug);
  page.signals.countReason('typed by a visitor');
  assert.deepEqual(page.sent.map(hit => hit.path), slugs.map(slug => 'uninstall-reason-' + slug));
  for (const hit of page.sent) {
    assert.equal(hit.event, true);
    assert.equal(hit.referrer, 'v0.3.0-beta.2');
    assert.match(hit.title, /^Uninstall reason: [A-Za-z ]+$/);
  }
});

test('the reason buttons on the uninstall page match the events that can be sent', () => {
  const html = fs.readFileSync(require.resolve('../docs/uninstalled.html'), 'utf8');
  const page = load(site + 'uninstalled.html', 'uninstalled');
  const slugs = [...html.matchAll(/data-reason="([^"]+)"/g)].map(match => match[1]);
  assert.equal(slugs.length, 6);
  for (const slug of slugs) page.signals.countReason(slug);
  assert.deepEqual(page.sent.map(hit => hit.path), slugs.map(slug => 'uninstall-reason-' + slug));
});

test('marked links count on click and middle click, and nothing else does', () => {
  const page = load(site);
  const link = {dataset: {signal: 'open-github'}};
  const target = {closest: selector => selector === 'a[data-signal]' ? link : null};
  page.listeners.click({type: 'click', button: 0, target});
  page.listeners.auxclick({type: 'auxclick', button: 1, target});
  page.listeners.auxclick({type: 'auxclick', button: 2, target});
  page.listeners.click({type: 'click', button: 0, target: {closest: () => null}});
  page.listeners.click({type: 'click', button: 0, target: {}});
  assert.deepEqual(page.sent.map(hit => hit.path), ['open-github', 'open-github']);
});

test('a missing or failing counter never throws into the page', () => {
  const blocked = load(site);
  delete blocked.settings.count;
  assert.doesNotThrow(() => blocked.signals.count('open-github'));
  const failing = load(site);
  failing.settings.count = () => { throw new Error('counter failed'); };
  assert.doesNotThrow(() => failing.signals.count('open-github'));
  assert.doesNotThrow(() => failing.signals.countReason('other'));
});

test('every page that loads the counter loads it through signals.js only', () => {
  for (const file of ['index.html', 'docs.html', 'uninstalled.html']) {
    const html = fs.readFileSync(require.resolve('../docs/' + file), 'utf8');
    assert.match(html, /<script src="signals\.js"[^>]* defer><\/script>/, file);
    assert.doesNotMatch(html, /goatcounter|zgo\.at/, file);
  }
});
