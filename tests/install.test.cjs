// Drive the packaged install with system tools in a fresh home; Node is only the test runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('prebuilt install, native request, legacy update, reinstall and uninstall', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'PaneParcel fresh home '));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const env = {HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin'};
  const install = (...flags) => execFileSync('/bin/sh', [path.join(__dirname, '../install.sh'), ...flags], {env});
  const support = path.join(home, 'Library/Application Support');
  const root = path.join(support, 'PaneParcel');
  const manifest = path.join(support, 'Google/Chrome/NativeMessagingHosts/com.micovi.paneparcel.json');
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
  const registration = json(manifest);
  assert.equal(registration.type, 'stdio');
  assert.deepEqual(registration.allowed_origins, ['chrome-extension://nbodoigokndfjagdocbaobppgepiflpf/', 'chrome-extension://hjaimaioehmmfbfclcmmphhenealomfp/']);
  assert.deepEqual(request(registration.path, 'targets'), {ok: true, starts: [], targets: []});
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
  uninstall();
  assert.equal(fs.existsSync(manifest), false);
  assert.equal(fs.existsSync(registration.path), false);
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
