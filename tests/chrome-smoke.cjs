// Run with a Chrome for Testing binary as argv[2]. Only the temporary profile is used.
const {execFileSync, spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');

async function main() {
  const executable = process.argv[2];
  assert.ok(executable, 'Pass the Chrome for Testing executable path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nitpost-browser-'));
  const support = path.join(home, 'Library/Application Support');
  const extension = path.join(support, 'Nitpost/extension');
  const previous = process.argv[3];
  const loaded = previous ? path.join(home, 'existing checkout/extension') : extension;
  const pageFile = path.join(home, 'review.html');
  fs.writeFileSync(pageFile, '<!doctype html><h1>Upgrade fixture</h1>');
  const pageUrl = pathToFileURL(pageFile).href;
  const state = {
    ['notes:' + pageUrl]: [{id:'old-note', selector:'h1', text:'Upgrade fixture', comment:'Keep this note', width:900, height:700}],
    recentProjects: [home],
    ['destination:' + new URL('.',pageUrl).href]: {project:home, target:null}
  };
  const profile = path.join(support, 'Google/Chrome');
  const env = {HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin'};
  const install = (...args) => execFileSync('/bin/sh', [path.join(__dirname, '../install.sh'), ...args], {env});
  let browser;
  try {
    if (previous) {
      fs.cpSync(path.join(previous, 'extension'), loaded, {recursive:true});
      // The legacy installer resolves rex even though this migration check sends no Rex commands.
      const bin = path.join(home, 'fixture-bin');
      fs.mkdirSync(bin);
      fs.symlinkSync('/usr/bin/false', path.join(bin, 'rex'));
      // The legacy launcher copies this PATH for its host, so it holds the fake rex and no real agent.
      execFileSync('python3', [path.join(previous, 'host/install.py')], {
        env:{...process.env, HOME:home, PATH:bin + ':' + env.PATH}
      });
    } else install();
    async function openProfile() {
      browser = spawn(executable, ['--headless', '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--disable-background-networking',
        '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + profile,
        '--load-extension=' + loaded, pageUrl], {env, stdio: ['ignore','ignore','ignore','pipe','pipe']});
      let id = 0, buffer = '';
      const pending = new Map();
      browser.stdio[4].setEncoding('utf8').on('data', data => {
        const frames = (buffer + data).split('\0');
        buffer = frames.pop();
        for (const frame of frames) {
          const msg = JSON.parse(frame);
          pending.get(msg.id)?.(msg);
        }
      });
      function rpc(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
          const seq = ++id;
          const timer = setTimeout(() => reject(Error(method + ' timed out')), 10000);
          pending.set(seq, msg => {
            clearTimeout(timer);
            pending.delete(seq);
            if (msg.error) reject(Error(msg.error.message)); else resolve(msg.result);
          });
          browser.stdio[3].write(JSON.stringify({id: seq, method, params, sessionId}) + '\0');
        });
      }
      const url = 'chrome-extension://nbodoigokndfjagdocbaobppgepiflpf/background.js';
      async function worker() {
        for (let i = 0; i < 50; i++) {
          const {targetInfos} = await rpc('Target.getTargets');
          const target = targetInfos.find(t => t.type === 'service_worker' && t.url === url);
          if (target) return {...await rpc('Target.attachToTarget', {targetId: target.targetId, flatten: true}), targetId: target.targetId};
          await delay(150);
        }
        throw Error('Packaged extension worker did not appear');
      }
      function evaluate(w, expression) {
        return rpc('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, w.sessionId)
          .then(r => {assert.ok(!r.exceptionDetails, r.exceptionDetails?.exception?.description); return r.result.value;});
      }
      const active = await worker();
      for (let i = 0; i < 50; i++) {
        if (await evaluate(active, "typeof chrome !== 'undefined' && !!chrome.runtime?.id")) break;
        await delay(100);
      }
      async function checkToolbar() {
        const {targetInfos} = await rpc('Target.getTargets', {filter:[{}]});
        const tab = targetInfos.find(info => info.type === 'tab' && info.url === pageUrl);
        const page = targetInfos.find(info => info.type === 'page' && info.url === pageUrl);
        assert.ok(tab && page, 'Local page and toolbar target');
        const attached = await rpc('Target.attachToTarget', {targetId:page.targetId, flatten:true});
        const tree = async () => JSON.stringify((await rpc('DOM.getDocument', {depth:-1,pierce:true}, attached.sessionId)).root);
        assert.ok(!(await tree()).includes('Keep this note'), 'Overlay is closed before the action');
        await rpc('Extensions.triggerAction', {id:new URL(url).hostname,targetId:tab.targetId});
        for (let i=0;i<50;i++) {
          if ((await tree()).includes('Keep this note')) return;
          await delay(100);
        }
        throw Error('Saved file annotation did not appear on toolbar click');
      }
      return {evaluate: expression => evaluate(active, expression), checkToolbar};
    }
    const first = await openProfile();
    // The temporary HOME has no agent, so the helper lists nothing and says why for each route.
    async function checkEmptyMachine(profile) {
      const {checks, ...listed} = await profile.evaluate("chrome.runtime.sendNativeMessage('com.micovi.nitpost',{op:'targets'})");
      assert.deepEqual(listed, {ok:true, starts:[], targets:[]});
      assert.deepEqual(checks?.map(check => [check.route, check.eligible]), [['claude',0],['codex',0],['tmux',0],['rex',0]],
        'The installed helper predates connection checks. Rebuild dist/ with scripts/package.sh.');
    }
    if (!previous) await checkEmptyMachine(first);
    else assert.equal((await first.evaluate("chrome.runtime.sendNativeMessage('com.micovi.nitpost',{op:'fixture'})")).ok, false);
    await first.evaluate('chrome.storage.local.set(' + JSON.stringify(state) + ')');
    const closed = once(browser, 'exit');
    browser.kill();
    await closed;
    install(...(previous ? ['--extension-dir', loaded] : []));
    const second = await openProfile();
    assert.deepEqual(await second.evaluate('chrome.storage.local.get(' + JSON.stringify(Object.keys(state)) + ')'),state);
    await checkEmptyMachine(second);
    await second.checkToolbar();
    console.log('Verified toolbar on local HTML, native messaging, same extension ID, notes and project preferences after upgrade.');
  } finally {
    if (browser && browser.exitCode === null) {
      const done = once(browser,'exit');
      browser.kill();
      await done;
    }
    fs.rmSync(home, {recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
