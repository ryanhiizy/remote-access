import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserLabel, label, locations, plist, shellQuote, sshArgs, validateConfig } from './config.mjs';

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(program)} failed: ${result.error?.message ?? (result.stderr?.trim() || result.status)}`);
  }
  return result.stdout;
}

export function privateWrite(file, text, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, file);
  chmodSync(file, mode);
}

// Direct SSH to WSL (not through the tunnel), for setup and status.
const ssh = (config, script) => run('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
  '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', config.host, '/bin/sh -s'], { input: script });

const tcpReady = (port, timeout = 2000) => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const finish = ready => { socket.destroy(); resolve(ready); };
  socket.setTimeout(timeout, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

// Runs on WSL, so every check crosses the tunnel the way agents use it.
export function probeScript(config) {
  const { app, browser, macLogin } = config.services;
  return [
    app && `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${app.remotePort}/ || true)
case "$code" in [1-5][0-9][0-9]) echo 'app ready';; *) echo 'app unavailable';; esac`,
    browser && `state=$(curl -s --max-time 3 http://127.0.0.1:${browser.remotePort}/status | sed -n 's/.*"state":"\\([a-z-]*\\)".*/\\1/p')
echo "browser \${state:-unavailable}"`,
    macLogin && `if timeout 8 ssh -F "$HOME/.config/remote-access/mac-ssh.conf" ${shellQuote(macLogin.address)} uname -s 2>/dev/null | grep -qx Darwin; then echo 'macLogin ready'; else echo 'macLogin unavailable'; fi`,
  ].filter(Boolean).join('\n');
}

const agentState = name => {
  try { return /state = running/.test(run('/bin/launchctl', ['print', `gui/${process.getuid()}/${name}`])) ? 'running' : 'restarting'; }
  catch { return 'not loaded'; }
};

export function status(config, platform = process.platform) {
  const result = { side: platform === 'darwin' ? 'mac' : 'wsl', host: config.host, services: {} };
  if (platform === 'darwin') result.agents = { tunnel: agentState(label), browser: config.services.browser ? agentState(browserLabel) : undefined };
  try {
    const output = platform === 'darwin' ? ssh(config, probeScript(config)) : run('/bin/sh', ['-s'], { input: probeScript(config) });
    for (const line of output.trim().split('\n')) { const [name, state] = line.split(' '); result.services[name] = state; }
  } catch (error) { result.error = error.message; }
  for (const name of Object.keys(config.services)) result.services[name] ??= 'unavailable';
  return result;
}

function provisionMacLogin(config, home) {
  const service = config.services.macLogin;
  if (!service) return;
  // The private key lives only on WSL. Pin the Mac's host key rather than trusting on first use.
  const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  const key = ssh(config, `set -eu
umask 077; mkdir -p "$HOME/.config/remote-access"
key="$HOME/.config/remote-access/mac_ed25519"
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C remote-access-mac -f "$key"
cat "$key.pub"
`).trim().split(/\s+/).slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) throw new Error('WSL returned an invalid SSH public key.');
  // WSL connects only over Tailscale (100.64.0.0/10).
  const authorized = path.join(home, '.ssh/authorized_keys');
  const lines = (existsSync(authorized) ? readFileSync(authorized, 'utf8') : '').split('\n').filter(line => line && !line.includes(key));
  privateWrite(authorized, `${[...lines, `from="100.64.0.0/10",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${key} remote-access-mac`].join('\n')}\n`);
  const macConfig = `Host ${service.address}\n  HostName ${service.address}\n  User ${service.user}\n  IdentityFile ~/.config/remote-access/mac_ed25519\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ~/.config/remote-access/mac_known_hosts\n  ConnectTimeout 5\n`;
  ssh(config, `set -eu; umask 077; cd "$HOME/.config/remote-access"
printf %s ${shellQuote(macConfig)} > mac-ssh.conf
printf '%s\\n' ${shellQuote(`${service.address} ${hostKey}`)} > mac_known_hosts
`);
}

const domain = () => `gui/${process.getuid()}`;
const plists = paths => [label, browserLabel].map(name => path.join(paths.agents, `${name}.plist`));

const loaded = name => { try { run('/bin/launchctl', ['print', `${domain()}/${name}`]); return true; } catch { return false; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// bootout returns before launchd finishes unloading; wait so a following bootstrap does not fail.
export async function stop(home = homedir()) {
  for (const name of [label, browserLabel]) {
    if (!loaded(name)) continue;
    run('/bin/launchctl', ['bootout', `${domain()}/${name}`]);
    for (let attempt = 0; attempt < 40 && loaded(name); attempt++) await pause(250);
  }
  return locations(home, 'darwin');
}

// launchd can still answer "Bootstrap failed: 5" briefly after an unload.
export async function start(home = homedir()) {
  const paths = locations(home, 'darwin');
  for (const [name, file] of [label, browserLabel].map((name, index) => [name, plists(paths)[index]])) {
    if (!existsSync(file) || loaded(name)) continue;
    for (let attempt = 0; ; attempt++) {
      try { run('/bin/launchctl', ['bootstrap', domain(), file]); break; }
      catch (error) { if (attempt >= 10 || !error.message.includes(': 5:')) throw error; await pause(500); }
    }
  }
}

export async function install(input, home = homedir()) {
  if (process.platform !== 'darwin') throw new Error('Install on your Mac. WSL uses status, mac, open, install-helpers and skills-sync.');
  const config = validateConfig(input);
  const paths = locations(home, 'darwin');
  const runtime = path.join(paths.directory, 'runtime');
  ssh(config, 'true\n');
  if (config.services.macLogin && !(await tcpReady(22))) {
    throw new Error('Enable Mac Remote Login in System Settings → General → Sharing, then retry.');
  }
  provisionMacLogin(config, home);
  await stop(home);

  privateWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  for (const module of ['config.mjs', 'browser-service.mjs', 'browser-client.mjs']) {
    privateWrite(path.join(runtime, module), readFileSync(fileURLToPath(new URL(`./${module}`, import.meta.url))));
  }
  const tokenFile = path.join(runtime, 'browser-token');
  if (config.services.browser) {
    // Snapshot the pinned dependency so moving or deleting this checkout does not break autostart.
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('chrome-devtools-mcp'))), '../..');
    const target = path.join(runtime, 'node_modules/chrome-devtools-mcp');
    const version = file => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).version;
    if (version(path.join(target, 'package.json')) !== version(path.join(source, 'package.json'))) {
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });
    }
    if (!existsSync(tokenFile)) privateWrite(tokenFile, randomBytes(32).toString('hex'));
  }

  const [tunnelPlist, browserPlist] = plists(paths);
  privateWrite(tunnelPlist, plist(label, ['/usr/bin/ssh', ...sshArgs(config)], path.join(paths.directory, 'tunnel.log')), 0o644);
  if (config.services.browser) {
    const { localPort, profile } = config.services.browser;
    privateWrite(browserPlist, plist(browserLabel, [process.execPath, path.join(runtime, 'browser-service.mjs'), String(localPort), profile, tokenFile],
      path.join(paths.directory, 'browser.log')), 0o644);
  } else rmSync(browserPlist, { force: true });
  await start(home);

  // Ready when every forward listens, and the reverse forward stays loopback-only on WSL.
  const remote = config.services.browser ? [config.services.browser.remotePort] : [];
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    await pause(500);
    const local = await Promise.all(['app', 'browser'].filter(name => config.services[name]).map(name => tcpReady(config.services[name].localPort)));
    if (agentState(label) !== 'running' || !local.every(Boolean)) continue;
    const listeners = ssh(config, 'ss -ltnH\n').split('\n').map(line => line.trim().split(/\s+/)[3]).filter(Boolean);
    ready = remote.every(port => {
      const bound = listeners.filter(address => address.endsWith(`:${port}`));
      return bound.length === 1 && bound[0] === `127.0.0.1:${port}`;
    });
  }
  if (!ready) throw new Error(`Tunnel not ready (or WSL sshd has GatewayPorts yes). See ${paths.directory}/tunnel.log.`);

  ssh(config, `set -eu; umask 077; cd "$HOME/.config/remote-access"
printf %s ${shellQuote(`${JSON.stringify(config, null, 2)}\n`)} > config.json
${config.services.browser ? `printf %s ${shellQuote(readFileSync(path.join(runtime, 'browser-client.mjs'), 'utf8'))} > browser-client.mjs
printf %s ${shellQuote(readFileSync(tokenFile, 'utf8'))} > browser-token` : ''}
`);
  const report = status(config);
  if (report.services.macLogin === 'unavailable') throw new Error('Mac SSH from WSL failed; check Remote Login allows this account.');
  return report;
}

export async function uninstall(home = homedir()) {
  await stop(home);
  for (const file of plists(locations(home, 'darwin'))) rmSync(file, { force: true });
}
