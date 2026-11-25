// Drive the packaged install with system tools in a fresh home; Node is only the test runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('prebuilt install, native request, legacy update, reinstall and uninstall', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'Nitpost fresh home '));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const env = {HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin'};
  const install = (...flags) => execFileSync('/bin/sh', [path.join(__dirname, '../install.sh'), ...flags], {env});
  const support = path.join(home, 'Library/Application Support');
  const root = path.join(support, 'Nitpost');
  const manifest = path.join(support, 'Google/Chrome/NativeMessagingHosts/com.micovi.nitpost.json');
  const json = file => JSON.parse(fs.readFileSync(file));
  function request(binary, op) {
    const body = Buffer.from(JSON.stringify({op}));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    const reply = execFileSync(binary, ['chrome-extension://nbodoigokndfjagdocbaobppgepiflpf/', 'chrome-extension://hjaimaioehmmfbfclcmmphhenealomfp/'], {env, input: Buffer.concat([head,body])});
    assert.equal(reply.readUInt32LE(), reply.length - 4);
    return JSON.parse(reply.subarray(4));
  }
  install();
  const skillSource = fs.readFileSync(path.join(__dirname, '../skills/nitpost/SKILL.md'));
  for (const agent of ['codex', 'claude']) {
    const dest = path.join(home, '.' + agent, 'skills/nitpost/SKILL.md');
    assert.equal(fs.existsSync(dest), false);
    install('--skill', agent);
    assert.deepEqual(fs.readFileSync(dest), skillSource);
  }
  const registration = json(manifest);
  assert.equal(registration.type, 'stdio');
  assert.deepEqual(registration.allowed_origins, ['chrome-extension://nbodoigokndfjagdocbaobppgepiflpf/', 'chrome-extension://hjaimaioehmmfbfclcmmphhenealomfp/']);
  // The packaged helper is the pinned dist archive. CI packages it from this source first, so
  // there it must speak the current protocol. A local checkout may hold an earlier archive.
  const current = request(registration.path, 'capabilities').payload === 2;
  if (!current) {
    assert.ok(!process.env.CI, 'The packaged helper predates this source. Run scripts/package.sh first.');
    t.diagnostic('dist archive predates this source: route checks and screenshot cleanup on uninstall were not exercised');
  }
  const listed = request(registration.path, 'targets');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.targets, []);
  assert.deepEqual(listed.starts, []);
  if (current) {
    assert.deepEqual(listed.checks.map(check => [check.route, check.found, check.eligible]),
      [['claude', 0, 0], ['codex', 0, 0], ['tmux', 0, 0], ['rex', 0, 0]]);
    for (const check of listed.checks) assert.ok(check.detail.length > 20 && !check.detail.includes(home), check.route);
  }
  assert.equal(request(registration.path, 'invalid').ok, false);
  assert.equal(json(path.join(root, 'extension/manifest.json')).key, json(path.join(__dirname, '../extension/manifest.json')).key);
  const shipped = path.join(__dirname, '../extension');
  const deployed = path.join(root, 'extension');
  const extensionManifest = json(path.join(deployed, 'manifest.json'));
  assert.ok(extensionManifest.action);
  assert.equal(extensionManifest.content_scripts, undefined);
  function compareAssets(dir) {
    for (const entry of fs.readdirSync(path.join(shipped, dir), {withFileTypes: true})) {
      if (entry.name === '.DS_Store') continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) compareAssets(relative);
      else assert.deepEqual(fs.readFileSync(path.join(deployed, relative)), fs.readFileSync(path.join(shipped, relative)), relative);
    }
  }
  compareAssets('');
  const other = path.join(home,'other extension');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other,'manifest.json'),JSON.stringify({key:'different'}));
  assert.throws(() => install('--extension-dir',other), /different extension/);
  assert.deepEqual(fs.readdirSync(other), ['manifest.json']);
  const uninstall = () => execFileSync(registration.path, ['register', 'uninstall'], {env});
  const cache = path.join(home, 'Library/Caches/com.micovi.nitpost');
  const shots = path.join(cache, 'shots');
  fs.mkdirSync(shots, {recursive: true});
  fs.writeFileSync(path.join(shots, 'note-a.jpg'), 'image');
  fs.writeFileSync(path.join(shots, 'note-reference-b.jpg'), 'image');
  uninstall();
  assert.equal(fs.existsSync(manifest), false);
  assert.equal(fs.existsSync(registration.path), false);
  if (current) assert.equal(fs.existsSync(shots), false);
  const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
  fs.writeFileSync(manifest, JSON.stringify({...registration, path: path.join(root, 'launch'), allowed_origins: [origin]}));
  fs.writeFileSync(path.join(root,'launch'), "#!/bin/sh\nexec python -I '" + root + "/bridge.py' '/fixture/Rex CLI' opencode\n");
  install();
  install();
  assert.ok(json(manifest).allowed_origins.includes(origin));
  assert.deepEqual(json(path.join(root,'settings.json')).agents, ['opencode']);
  install('--agent', 'custom');
  assert.deepEqual(json(path.join(root,'settings.json')).agents, ['custom']);
  uninstall();
  assert.ok(fs.existsSync(path.join(root, 'extension/manifest.json')));
});
