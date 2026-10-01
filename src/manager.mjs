import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionConfig, label, locations, shellQuote, tunnelPlist, validateConfig } from './config.mjs';

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(program)} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  return result.stdout;
}

export function privateWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function inventory(home = homedir(), execute = run) {
  const directory = path.join(home, 'Library/LaunchAgents');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(file => file.endsWith('.plist')).flatMap(file => {
    try {
      const plist = JSON.parse(execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(directory, file)]));
      const args = plist.ProgramArguments ?? [plist.Program];
      if (!/ssh|executor|tunnel|remote|wsl|helium/i.test(`${plist.Label} ${args.join(' ')}`)) return [];
      return [{ label: plist.Label, file: path.join(directory, file), arguments: args }];
    } catch {
      return [{ file: path.join(directory, file), error: 'Could not parse this LaunchAgent.' }];
    }
  });
}

function ssh(config, script, execute = run) {
  return execute('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
    config.host, '/bin/sh -s'], { input: script });
}

export const tcpReady = (port, timeout = 2000) => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  let settled = false;
  const finish = ready => { if (!settled) { settled = true; socket.destroy(); resolve(ready); } };
  socket.setTimeout(timeout, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

export function probeScript(config) {
  const lines = ['set -u'];
  for (const [name, service] of Object.entries(config.services)) {
    if (name === 'macLogin') {
      lines.push(`if timeout 8 ssh -F "$HOME/.config/remote-access/mac-ssh.conf" mac-remote uname -s 2>/dev/null | grep -qx Darwin; then echo 'macLogin ready'; else echo 'macLogin unavailable'; fi`);
    } else {
      const suffix = '/';
      if (name === 'browser') {
        lines.push(`if curl --max-time 3 -fsS http://127.0.0.1:${service.remotePort}/json/version 2>/dev/null | grep -q '"webSocketDebuggerUrl"'; then echo 'browser ready'; else echo 'browser unavailable'; fi`);
        continue;
      }
      lines.push(`code=$(curl --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${service.remotePort}${suffix} 2>/dev/null || true)`);
      lines.push(`case "$code" in [1-5][0-9][0-9]) echo '${name} ready';; *) echo '${name} unavailable';; esac`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function status(config, { platform = process.platform, home = homedir(), execute = run } = {}) {
  const paths = locations(home, platform);
  const result = { host: config.host, side: platform === 'darwin' ? 'mac' : 'wsl', services: {}, log: paths.log };
  if (platform === 'darwin') {
    try {
      const state = execute('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
      result.tunnel = /state = running/.test(state) ? 'running' : 'waiting to reconnect';
    } catch { result.tunnel = 'not loaded'; }
    if (result.tunnel === 'running') {
      try {
        const worker = JSON.parse(readFileSync(path.join(paths.directory, 'state.json'), 'utf8'));
        const loaded = execute('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
        const pid = Number(loaded.match(/\bpid = (\d+)/)?.[1]);
        if (worker.pid !== pid) result.tunnel = 'starting';
        else if (worker.state !== 'connected') result.tunnel = worker.state;
      } catch { result.tunnel = 'starting'; }
    }
    for (const name of ['app', 'executor']) {
      if (!config.services[name]) continue;
      const service = config.services[name];
      // An HTTP response checks traffic through the tunnel, not just an open listener.
      try {
        const code = execute('/usr/bin/curl', ['--max-time', '3', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${service.localPort}/`]);
        result.services[name] = /^[1-5][0-9]{2}$/.test(code) ? 'ready' : 'unavailable';
      } catch { result.services[name] = 'unavailable'; }
    }
  }
  try {
    const output = platform === 'darwin' ? ssh(config, probeScript(config), execute)
      : execute('/bin/sh', ['-s'], { input: probeScript(config) });
    for (const line of output.trim().split('\n')) {
      const [name, state] = line.split(' ');
      if (name in config.services && (platform !== 'darwin' || !['app', 'executor'].includes(name))) result.services[name] = state;
    }
  } catch (error) { result.remoteError = error.message; }
  for (const name of Object.keys(config.services)) result.services[name] ??= 'unavailable';
  return result;
}

function provisionMacLogin(config, home, execute) {
  const service = config.services.macLogin;
  if (!service) return;
  // The private key lives only on WSL. Pin the Mac's local SSH host key before
  // connecting through the reverse forward, rather than accepting it blindly.
  const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(hostKey)) throw new Error('Cannot read the Mac SSH host public key. Enable Remote Login first.');
  const key = ssh(config, `set -eu
umask 077
mkdir -p "$HOME/.config/remote-access"
chmod 700 "$HOME/.config/remote-access"
key="$HOME/.config/remote-access/mac_ed25519"
if [ ! -f "$key" ]; then ssh-keygen -q -t ed25519 -N '' -C remote-access-mac -f "$key"; fi
cat "$key.pub"
`, execute).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(key)) throw new Error('WSL returned an invalid SSH public key.');
  const publicKey = key.split(/\s+/).slice(0, 2).join(' ');
  const authorized = path.join(home, '.ssh/authorized_keys');
  const current = existsSync(authorized) ? readFileSync(authorized, 'utf8') : '';
  if (!current.split('\n').some(line => line.includes(publicKey))) {
    privateWrite(authorized, `${current}${current && !current.endsWith('\n') ? '\n' : ''}from="127.0.0.1,::1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${publicKey} remote-access-mac\n`);
  }
  const macConfig = `Host mac-remote\n  HostName 127.0.0.1\n  Port ${service.remotePort}\n  User ${service.user}\n  IdentityFile ~/.config/remote-access/mac_ed25519\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  HostKeyAlias remote-access-mac\n  UserKnownHostsFile ~/.config/remote-access/mac_known_hosts\n  ConnectTimeout 5\n`;
  ssh(config, `set -eu
umask 077
directory="$HOME/.config/remote-access"
printf %s ${shellQuote(macConfig)} > "$directory/mac-ssh.conf"
printf '%s\\n' ${shellQuote(`remote-access-mac ${hostKey}`)} > "$directory/mac_known_hosts"
chmod 600 "$directory/mac-ssh.conf" "$directory/mac_known_hosts"
`, execute);
}

export async function install(input, { platform = process.platform, home = homedir(), execute = run, ready = tcpReady, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (platform !== 'darwin') throw new Error('Install the connection service on your Mac. WSL uses status and mac commands.');
  const config = validateConfig(input);
  const paths = locations(home, platform);
  const domain = `gui/${process.getuid()}`;
  const resolved = execute('/usr/bin/ssh', ['-G', config.host]);
  ssh(config, 'true\n', execute);
  if (config.services.macLogin && !(await ready(config.services.macLogin.localPort))) {
    throw new Error('Enable Mac Remote Login in System Settings → General → Sharing, restricted to your account, then retry.');
  }
  const agents = inventory(home, execute);
  const replacements = config.replaceAgents.map(agent => {
    const item = agents.find(candidate => candidate.label === agent);
    if (!item) throw new Error(`LaunchAgent ${agent} was not found. Run inspect before choosing replacements.`);
    return item;
  });
  // Include our own previous version in rollback; retain exact files and load states.
  if (existsSync(paths.plist)) replacements.push({ label, file: paths.plist });
  const snapshots = replacements.map(agent => {
    let loaded = false;
    try { execute('/bin/launchctl', ['print', `${domain}/${agent.label}`]); loaded = true; } catch { /* not loaded */ }
    return { ...agent, loaded, contents: readFileSync(agent.file) };
  });
  const previousConfig = existsSync(paths.config) ? readFileSync(paths.config) : null;
  const sshFile = path.join(paths.directory, 'tunnel-ssh.conf');
  const previousSsh = existsSync(sshFile) ? readFileSync(sshFile) : null;
  const runtime = ['worker.mjs', 'config.mjs'].map(module => {
    const file = path.join(paths.directory, 'runtime', module);
    return { module, file, previous: existsSync(file) ? readFileSync(file) : null };
  });
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const backup = path.join(paths.directory, 'backups', `${Date.now()}-${process.pid}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const agent of snapshots) privateWrite(path.join(backup, path.basename(agent.file)), agent.contents);
  if (previousConfig) privateWrite(path.join(backup, 'config.json'), previousConfig);
  if (previousSsh) privateWrite(path.join(backup, 'tunnel-ssh.conf'), previousSsh);
  for (const file of runtime) if (file.previous) privateWrite(path.join(backup, 'runtime', file.module), file.previous);
  const authorized = path.join(home, '.ssh/authorized_keys');
  const previousAuthorized = existsSync(authorized) ? readFileSync(authorized) : null;
  const remoteBackup = `migration-${Date.now()}-${process.pid}`;
  ssh(config, `set -eu
umask 077
directory="$HOME/.config/remote-access"
backup="$directory/backups/${remoteBackup}"
mkdir -p "$backup"
for file in config.json mac-ssh.conf mac_known_hosts; do
  if [ -f "$directory/$file" ]; then cp "$directory/$file" "$backup/$file"; else touch "$backup/$file.absent"; fi
done
`, execute);
  const stopped = new Set();
  let newLoaded = false;
  try {
    provisionMacLogin(config, home, execute);
    for (const agent of snapshots) if (agent.loaded) {
      execute('/bin/launchctl', ['bootout', `${domain}/${agent.label}`]);
      stopped.add(agent.label);
    }
    privateWrite(sshFile, connectionConfig(resolved, home));
    privateWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`);
    for (const file of runtime) {
      privateWrite(file.file, readFileSync(fileURLToPath(new URL(`./${file.module}`, import.meta.url))));
    }
    // Snapshot runtime files so the connection survives moving/deleting the checkout.
    // Create logs with private permissions before launchd opens them.
    if (!existsSync(paths.log)) privateWrite(paths.log, '');
    privateWrite(paths.plist, tunnelPlist(config, paths));
    execute('/usr/bin/plutil', ['-lint', paths.plist]);
    execute('/bin/launchctl', ['bootstrap', domain, paths.plist]);
    newLoaded = true;
    let running = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const state = execute('/bin/launchctl', ['print', `${domain}/${label}`]);
      const listeners = await Promise.all(['app', 'executor'].filter(name => config.services[name]).map(name => ready(config.services[name].localPort)));
      let connected = false;
      try {
        const worker = JSON.parse(readFileSync(path.join(paths.directory, 'state.json'), 'utf8'));
        connected = worker.state === 'connected' && worker.pid === Number(state.match(/\bpid = (\d+)/)?.[1]);
      } catch { /* Worker has not reported readiness yet. */ }
      if (/state = running/.test(state) && connected && listeners.every(Boolean)) {
        const remoteListeners = ssh(config, 'ss -ltnH\n', execute);
        running = ['browser', 'macLogin'].filter(name => config.services[name]).every(name => {
          const port = config.services[name].remotePort;
          const addresses = remoteListeners.split('\n').map(line => line.trim().split(/\s+/)[3]).filter(address => address?.endsWith(`:${port}`));
          return addresses.length === 1 && addresses[0] === `127.0.0.1:${port}`;
        });
        if (running) break;
      }
      await pause(500);
    }
    if (!running) throw new Error(`Tunnel did not acquire its loopback listeners. Inspect ${paths.log}.`);
    if (config.services.macLogin) {
      const report = ssh(config, probeScript({ ...config, services: { macLogin: config.services.macLogin } }), execute);
      if (!report.includes('macLogin ready')) throw new Error('Mac SSH authentication failed; check Remote Login allows this Mac account.');
    }
    // Reinstalls use the saved configuration without already-migrated labels.
    const installed = { ...config, replaceAgents: [] };
    ssh(config, `set -eu\numask 077\nprintf %s ${shellQuote(`${JSON.stringify(installed, null, 2)}\n`)} > "$HOME/.config/remote-access/config.json"\nchmod 600 "$HOME/.config/remote-access/config.json"\n`, execute);
    privateWrite(paths.config, `${JSON.stringify(installed, null, 2)}\n`);
    for (const agent of snapshots) if (agent.label !== label) rmSync(agent.file);
    return { config: paths.config, backup, log: paths.log };
  } catch (error) {
    const failures = [];
    if (newLoaded) {
      try { execute('/bin/launchctl', ['bootout', `${domain}/${label}`]); }
      catch (stopError) { failures.push(`New tunnel stop: ${stopError.message}`); }
    }
    rmSync(paths.plist, { force: true });
    if (previousConfig) privateWrite(paths.config, previousConfig); else rmSync(paths.config, { force: true });
    if (previousSsh) privateWrite(sshFile, previousSsh); else rmSync(sshFile, { force: true });
    for (const file of runtime) {
      if (file.previous) privateWrite(file.file, file.previous); else rmSync(file.file, { force: true });
    }
    if (config.services.macLogin) {
      if (previousAuthorized) privateWrite(authorized, previousAuthorized); else rmSync(authorized, { force: true });
    }
    try {
      ssh(config, `set -eu
directory="$HOME/.config/remote-access"
backup="$directory/backups/${remoteBackup}"
for file in config.json mac-ssh.conf mac_known_hosts; do
  if [ -f "$backup/$file.absent" ]; then rm -f "$directory/$file"; else cp "$backup/$file" "$directory/$file"; fi
done
`, execute);
    } catch (restoreError) { failures.push(`WSL config: ${restoreError.message}`); }
    for (const agent of snapshots) {
      privateWrite(agent.file, agent.contents);
      if (stopped.has(agent.label)) {
        try { execute('/bin/launchctl', ['bootstrap', domain, agent.file]); }
        catch (restoreError) { failures.push(`${agent.label}: ${restoreError.message}`); }
      }
    }
    throw new Error(`${error.message} Previous tunnel files restored; backups: ${backup}.${failures.length ? ` Restore failures: ${failures.join('; ')}` : ''}`);
  }
}

export function stop({ home = homedir(), execute = run } = {}) {
  const paths = locations(home, 'darwin');
  execute('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
  return paths;
}

export function start({ home = homedir(), execute = run } = {}) {
  const paths = locations(home, 'darwin');
  execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.plist]);
  return paths;
}
