import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { label, locations, plist, shellQuote, sshArgs, validateConfig } from './config.mjs';

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

// Windows OpenSSH runs commands in Windows PowerShell; -EncodedCommand avoids nested quoting.
export const powershell = script => `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
export const windowsSshArgs = (config, command) => ['-T', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
  '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-p', String(config.windows.port), config.windows.host, command];
const windowsReachable = config => spawnSync('/usr/bin/ssh', windowsSshArgs(config, 'exit'), { stdio: 'ignore', timeout: 20000 }).status === 0;

// Last crash dump, keep-alive state and distro states, then restart the keep-alive task.
export const recoverScript = `$f = Get-ChildItem "$env:LOCALAPPDATA\\Temp\\wsl-crashes" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if ($f) { "last crash: $($f.Name) $($f.LastWriteTime.ToString('s'))" } else { 'last crash: none' }
$i = Get-ScheduledTaskInfo -TaskName 'WSL keep-alive' -ErrorAction SilentlyContinue
if ($i) { "keep-alive: last run $($i.LastRunTime.ToString('s')), result 0x$($i.LastTaskResult.ToString('X'))" } else { 'keep-alive: task missing; run windows/setup.ps1' }
$env:WSL_UTF8 = '1'
wsl.exe -l -v | Where-Object { $_.Trim() }
Start-ScheduledTask -TaskName 'WSL keep-alive'
`;

const tcpReady = (port, timeout = 2000) => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const finish = ready => { socket.destroy(); resolve(ready); };
  socket.setTimeout(timeout, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

// Runs on WSL, so every check crosses the tunnel the way agents use it.
export function probeScript(config) {
  const { app, macLogin } = config.services;
  return [
    app && `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${app.remotePort}/ || true)
case "$code" in [1-5][0-9][0-9]) echo 'app ready';; *) echo 'app unavailable';; esac`,
    macLogin && `if timeout 8 ssh -F "$HOME/.config/remote-access/mac-ssh.conf" ${shellQuote(macLogin.address)} uname -s 2>/dev/null | grep -qx Darwin; then echo 'macLogin ready'; else echo 'macLogin unavailable'; fi`,
  ].filter(Boolean).join('\n');
}

const agentState = name => {
  try { return /state = running/.test(run('/bin/launchctl', ['print', `gui/${process.getuid()}/${name}`])) ? 'running' : 'restarting'; }
  catch { return 'not loaded'; }
};

export function status(config, platform = process.platform) {
  const result = { side: platform === 'darwin' ? 'mac' : 'wsl', host: config.host, services: {} };
  if (platform === 'darwin') result.agents = { tunnel: agentState(label) };
  // Separates "Windows down" (laptop off or offline) from "WSL down" (recover).
  if (platform === 'darwin' && config.windows) result.windows = windowsReachable(config) ? 'ready' : 'unavailable';
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
  // Connection reuse turns each helper call's ~0.2s handshake into ~0.03s.
  const macConfig = `Host ${service.address}\n  HostName ${service.address}\n  User ${service.user}\n  IdentityFile ~/.config/remote-access/mac_ed25519\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ~/.config/remote-access/mac_known_hosts\n  ConnectTimeout 5\n  ControlMaster auto\n  ControlPath ~/.config/remote-access/cm-%C\n  ControlPersist 10m\n`;
  ssh(config, `set -eu; umask 077; cd "$HOME/.config/remote-access"
printf %s ${shellQuote(macConfig)} > mac-ssh.conf
printf '%s\\n' ${shellQuote(`${service.address} ${hostKey}`)} > mac_known_hosts
`);
}

const domain = () => `gui/${process.getuid()}`;
const plistFile = paths => path.join(paths.agents, `${label}.plist`);

const loaded = name => { try { run('/bin/launchctl', ['print', `${domain()}/${name}`]); return true; } catch { return false; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// bootout returns before launchd finishes unloading; wait so a following bootstrap does not fail.
export async function stop(home = homedir()) {
  if (loaded(label)) {
    run('/bin/launchctl', ['bootout', `${domain()}/${label}`]);
    for (let attempt = 0; attempt < 40 && loaded(label); attempt++) await pause(250);
  }
  return locations(home, 'darwin');
}

// launchd can still answer "Bootstrap failed: 5" briefly after an unload.
export async function start(home = homedir()) {
  const file = plistFile(locations(home, 'darwin'));
  if (!existsSync(file) || loaded(label)) return;
  for (let attempt = 0; ; attempt++) {
    try { run('/bin/launchctl', ['bootstrap', domain(), file]); break; }
    catch (error) { if (attempt >= 10 || !error.message.includes(': 5:')) throw error; await pause(500); }
  }
}

export async function install(input, home = homedir()) {
  if (process.platform !== 'darwin') throw new Error('Install on your Mac. WSL uses status, mac, open, install-helpers and skills-sync.');
  const config = validateConfig(input);
  const paths = locations(home, 'darwin');
  ssh(config, 'true\n');
  if (config.services.macLogin && !(await tcpReady(22))) {
    throw new Error('Enable Mac Remote Login in System Settings → General → Sharing, then retry.');
  }
  provisionMacLogin(config, home);
  await stop(home);

  privateWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  privateWrite(plistFile(paths), plist(label, ['/usr/bin/ssh', ...sshArgs(config)], path.join(paths.directory, 'tunnel.log')), 0o644);
  await start(home);

  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    await pause(500);
    ready = agentState(label) === 'running' && (!config.services.app || await tcpReady(config.services.app.localPort));
  }
  if (!ready) throw new Error(`Tunnel not ready. See ${paths.directory}/tunnel.log.`);

  ssh(config, `set -eu; umask 077; cd "$HOME/.config/remote-access"
printf %s ${shellQuote(`${JSON.stringify(config, null, 2)}\n`)} > config.json
`);
  const report = status(config);
  if (report.services.macLogin === 'unavailable') throw new Error('Mac SSH from WSL failed; check Remote Login allows this account.');
  return report;
}

export async function recover(config, timeout = 120000) {
  if (!config.windows) throw new Error('Add "windows": {} to the config and run windows/setup.ps1 first.');
  let report;
  try { report = run('/usr/bin/ssh', windowsSshArgs(config, powershell(recoverScript)), { timeout: 60000 }); }
  catch (error) { throw new Error(`Windows SSH unreachable (${error.message}); the laptop is off, asleep or offline.`); }
  console.log(report.trim());
  const started = Date.now();
  for (;;) {
    try { ssh(config, 'true\n'); break; }
    catch { if (Date.now() - started > timeout) throw new Error(`WSL SSH still down after ${timeout / 1000}s.`); await pause(3000); }
  }
  console.log(`WSL SSH: ready after ${Math.round((Date.now() - started) / 1000)}s`);
}

export async function uninstall(home = homedir()) {
  await stop(home);
  rmSync(plistFile(locations(home, 'darwin')), { force: true });
}
