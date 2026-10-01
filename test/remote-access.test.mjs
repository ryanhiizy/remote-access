import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectionConfig, defaultConfig, label, locations, shellQuote, sshArgs, tunnelPlist, validateConfig } from '../src/config.mjs';
import { install, inventory, privateWrite, status, tcpReady } from '../src/manager.mjs';
import { browserRelay, readEndpoint, remoteCommand } from '../src/worker.mjs';

function temporary(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'remote-access-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('one SSH connection forwards four services in both directions on loopback', () => {
  const config = defaultConfig('workstation', true);
  config.services.executor = { localPort: 14789, remotePort: 4789 };
  const args = sshArgs(config);
  assert.ok(args.includes('127.0.0.1:8080:127.0.0.1:8080'));
  assert.ok(args.includes('127.0.0.1:14789:127.0.0.1:4789'));
  assert.ok(args.includes('127.0.0.1:9223:127.0.0.1:19222'));
  assert.ok(args.includes('127.0.0.1:2222:127.0.0.1:22'));
  assert.equal(args.filter(arg => arg === '-L').length, 2);
  assert.equal(args.filter(arg => arg === '-R').length, 2);
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('GatewayPorts=no'));
  assert.ok(!args.includes('ClearAllForwardings=yes'));
  assert.equal(args.at(-1), 'workstation');
});

test('rejects option injection, unknown services, invalid ports and same-side conflicts', () => {
  const config = defaultConfig('workstation');
  for (const host of ['-oProxyCommand=anything', 'two hosts', '$(touch /tmp/file)', '../somewhere']) {
    assert.throws(() => validateConfig({ ...config, host }));
  }
  assert.throws(() => validateConfig({ ...config, services: { unknown: { localPort: 8000, remotePort: 8000 } } }));
  assert.throws(() => validateConfig({ ...config, services: { app: { localPort: 22, remotePort: 8080 } } }));
  assert.throws(() => validateConfig({ ...config, services: { ...config.services, executor: { localPort: 8080, remotePort: 4789 } } }));
  assert.throws(() => validateConfig({ ...config, replaceAgents: ['../other'] }));
  assert.throws(() => validateConfig({ ...config, replaceAgents: [label] }));
  assert.throws(() => validateConfig({ ...config, services: { macLogin: { localPort: 22, remotePort: 2222, user: 'user\ncommand' } } }));
  assert.throws(() => validateConfig({ ...config, services: {} }));
  // Same number on different machines is valid when endpoints are distinct.
  assert.doesNotThrow(() => validateConfig({ ...config, services: { app: { localPort: 8080, remotePort: 18080 }, executor: { localPort: 18080, remotePort: 4789 } } }));
  assert.throws(() => validateConfig({ ...config, services: { ...config.services, browser: { ...config.services.browser, localPort: 8080 } } }));
});

test('generated plist escapes paths and includes login startup and private log paths', () => {
  const plist = tunnelPlist(defaultConfig('workstation'), locations('/Users/a & b', 'darwin'));
  assert.ok(plist.includes('/Users/a &amp; b/'));
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
  assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(plist.includes('<key>StandardErrorPath</key>'));
});

test('resolved SSH configuration removes old forwards and keeps jump-host lookup', t => {
  const home = temporary(t);
  mkdirSync(path.join(home, '.ssh'));
  writeFileSync(path.join(home, '.ssh/config'), 'Host target\n HostName 127.0.0.1\n LocalForward 1234 localhost:5678\nHost jump\n HostName 192.0.2.10\n User jumper\n');
  const resolved = spawnSync('ssh', ['-G', '-F', path.join(home, '.ssh/config'), 'target'], { encoding: 'utf8' });
  assert.equal(resolved.status, 0);
  const file = path.join(home, 'snapshot');
  writeFileSync(file, connectionConfig(resolved.stdout, home));
  const target = spawnSync('ssh', ['-G', '-F', file, 'target'], { encoding: 'utf8' });
  assert.equal(target.status, 0, target.stderr);
  assert.ok(!target.stdout.includes('localforward '));
  assert.match(target.stdout, /hostname 127\.0\.0\.1/);
  const jump = spawnSync('ssh', ['-G', '-F', file, 'jump'], { encoding: 'utf8' });
  assert.equal(jump.status, 0, jump.stderr);
  assert.match(jump.stdout, /hostname 192\.0\.2\.10/);
  assert.match(jump.stdout, /user jumper/);
});

test('shell quoting preserves data without interpreting substitutions', () => {
  const value = "some ' text; $(printf BAD) `printf BAD`\nnext";
  const result = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, value);
});

test('private file writes preserve contents and remove excessive permissions', t => {
  const file = path.join(temporary(t), 'private/config');
  privateWrite(file, 'first');
  privateWrite(file, 'second');
  assert.equal(readFileSync(file, 'utf8'), 'second');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('listener probe distinguishes a live service from a closed port', async t => {
  const server = createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await tcpReady(port), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await tcpReady(port), false);
});

function fixture(t, { failBootstrap = false, publicListener = false, stoppedFailure = false } = {}) {
  const home = temporary(t);
  const old = path.join(home, 'Library/LaunchAgents/old.tunnel.plist');
  mkdirSync(path.dirname(old), { recursive: true });
  writeFileSync(old, 'ORIGINAL');
  const calls = [];
  const execute = (program, args, options) => {
    calls.push({ program, args, input: options?.input });
    if (program.endsWith('plutil') && args.includes('json')) return JSON.stringify({ Label: 'old.tunnel', ProgramArguments: ['/usr/bin/ssh', '-N', 'target'] });
    if (program.endsWith('ssh') && args[0] === '-G') return 'host target\nhostname 127.0.0.1\nuser test\nlocalforward 3000 localhost:3000\n';
    if (program.endsWith('ssh') && options?.input === 'ss -ltnH\n') return `LISTEN 0 128 ${publicListener ? '0.0.0.0' : '127.0.0.1'}:9223 0.0.0.0:*\n`;
    if (program.endsWith('launchctl') && args[0] === 'print') return 'state = running\npid = 1234';
    if (program.endsWith('launchctl') && args[0] === 'bootout' && args[1].endsWith('/old.tunnel') && stoppedFailure) throw new Error('could not stop');
    if (program.endsWith('launchctl') && args[0] === 'bootstrap' && args.at(-1).endsWith(`${label}.plist`) && failBootstrap) throw new Error('bootstrap rejected');
    if (program.endsWith('launchctl') && args[0] === 'bootstrap' && args.at(-1).endsWith(`${label}.plist`)) {
      privateWrite(path.join(locations(home, 'darwin').directory, 'state.json'), JSON.stringify({ state: 'connected', pid: 1234 }));
    }
    return '';
  };
  const config = { ...defaultConfig('target'), replaceAgents: ['old.tunnel'] };
  const options = { platform: 'darwin', home, execute, ready: async () => true, pause: async () => {} };
  return { home, old, config, options, calls };
}

test('successful migration backs up and retires only selected agents', async t => {
  const f = fixture(t);
  const unrelated = path.join(f.home, 'Library/LaunchAgents/unrelated.plist');
  writeFileSync(unrelated, 'UNRELATED');
  const result = await install(f.config, f.options);
  assert.equal(existsSync(f.old), false);
  assert.equal(readFileSync(path.join(result.backup, 'old.tunnel.plist'), 'utf8'), 'ORIGINAL');
  assert.equal(readFileSync(unrelated, 'utf8'), 'UNRELATED');
  assert.deepEqual(JSON.parse(readFileSync(result.config)).replaceAgents, []);
  assert.ok(f.calls.some(call => call.args[0] === 'bootout' && call.args[1].endsWith('/old.tunnel')));
});

test('failed installation restores files and previously loaded services', async t => {
  const f = fixture(t, { failBootstrap: true });
  await assert.rejects(install(f.config, f.options), /Previous tunnel files restored/);
  assert.equal(readFileSync(f.old, 'utf8'), 'ORIGINAL');
  assert.equal(existsSync(locations(f.home, 'darwin').plist), false);
  assert.equal(existsSync(locations(f.home, 'darwin').config), false);
  assert.ok(f.calls.some(call => call.args[0] === 'bootstrap' && call.args.at(-1) === f.old));
});

test('failed stop does not bootstrap an original service that is still running', async t => {
  const f = fixture(t, { stoppedFailure: true });
  await assert.rejects(install(f.config, f.options), /could not stop/);
  assert.equal(readFileSync(f.old, 'utf8'), 'ORIGINAL');
  assert.ok(!f.calls.some(call => call.args[0] === 'bootstrap' && call.args.at(-1) === f.old));
});

test('public reverse listener is rejected and migration rolls back', async t => {
  const f = fixture(t, { publicListener: true });
  await assert.rejects(install(f.config, f.options), /loopback listeners/);
  assert.equal(readFileSync(f.old, 'utf8'), 'ORIGINAL');
  assert.ok(f.calls.some(call => call.args[0] === 'bootout' && call.args[1].endsWith(`/${label}`)));
});

test('status checks service responses and reports unavailable routes', async t => {
  const config = defaultConfig('target', true);
  config.services.executor = { localPort: 14789, remotePort: 4789 };
  const home = temporary(t);
  privateWrite(path.join(locations(home, 'darwin').directory, 'state.json'), JSON.stringify({ state: 'connected', pid: 1234 }));
  const execute = (program, args) => {
    if (program.endsWith('launchctl')) return 'state = running\npid = 1234';
    if (program.endsWith('curl')) return args.at(-1).includes(':8080') ? '404' : '000';
    if (program.endsWith('ssh')) return 'app ready\nexecutor ready\nbrowser unavailable\nmacLogin ready\n';
    throw new Error('unexpected call');
  };
  const report = await status(config, { platform: 'darwin', home, execute });
  assert.equal(report.tunnel, 'running');
  assert.deepEqual(report.services, { app: 'ready', executor: 'unavailable', browser: 'unavailable', macLogin: 'ready' });
});

test('browser relay follows changed Helium debug ports without restarting its listener', async t => {
  const profile = temporary(t);
  const first = createServer(socket => { socket.end('first'); });
  const second = createServer(socket => { socket.end('second'); });
  const relay = browserRelay(profile);
  for (const server of [first, second, relay.server]) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  t.after(() => { relay.close(); first.close(); second.close(); });
  const metadata = path.join(profile, 'DevToolsActivePort');
  const connect = async () => {
    const { createConnection } = await import('node:net');
    const socket = createConnection({ host: '127.0.0.1', port: relay.server.address().port });
    const [data] = await once(socket, 'data');
    socket.destroy();
    return data.toString();
  };
  writeFileSync(metadata, `${first.address().port}\n/devtools/browser/first\n`);
  assert.equal(await connect(), 'first');
  writeFileSync(metadata, `${second.address().port}\n/devtools/browser/second\n`);
  assert.equal(await connect(), 'second');
  writeFileSync(metadata, '9000\ninvalid\n');
  assert.equal(readEndpoint(profile), null);
});

test('remote browser metadata protocol updates, removes and rejects invalid paths', t => {
  const home = temporary(t);
  const script = remoteCommand({ remotePort: 19223 });
  const result = spawnSync('/bin/sh', ['-c', script], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
    input: `${JSON.stringify({ path: '/devtools/browser/abc-123' })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = path.join(home, '.local/share/codex-browser/mac-profile/DevToolsActivePort');
  assert.equal(readFileSync(metadata, 'utf8'), '19223\n/devtools/browser/abc-123\n');
  const removed = spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8', input: 'null\n' });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(metadata), false);
  const rejected = spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8', input: '{"path":"../../bad"}\n' });
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(metadata), false);
});

test('inventory leaves unrelated services out of migration candidates', t => {
  const home = temporary(t);
  const directory = path.join(home, 'Library/LaunchAgents');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'google.plist'), '');
  writeFileSync(path.join(directory, 'tunnel.plist'), '');
  const list = inventory(home, (_program, args) => args.at(-1).includes('google')
    ? JSON.stringify({ Label: 'com.google.updater', ProgramArguments: ['/bin/updater'] })
    : JSON.stringify({ Label: 'au.ender.codex-helium-tunnel', ProgramArguments: ['/bin/python3', '/path/agent.py'] }));
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'au.ender.codex-helium-tunnel');
});

test('CLI rejects installation on WSL and stores init config only at an explicit local path', t => {
  const config = path.join(temporary(t), 'local.json');
  const init = spawnSync(process.execPath, ['bin/remote-access.mjs', 'init', '--config', config, '--host', 'target', '--replace', 'old.tunnel'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(readFileSync(config)).replaceAgents, ['old.tunnel']);
  if (process.platform !== 'darwin') {
    const result = spawnSync(process.execPath, ['bin/remote-access.mjs', 'install', '--config', config], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Install the connection service on your Mac/);
  }
});
