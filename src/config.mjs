import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

export function readEndpoint(profile) {
  try {
    const [port, websocket, extra] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    if (extra !== undefined || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
      || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(websocket ?? '')) return null;
    return { port: Number(port), path: websocket };
  } catch { return null; }
}

export const label = 'io.github.ryanhiizy.remote-access';
export const serviceNames = ['app', 'executor', 'browser', 'macLogin'];

export function locations(home = homedir(), platform = process.platform) {
  const directory = platform === 'darwin'
    ? path.join(home, 'Library/Application Support/remote-access')
    : path.join(home, '.config/remote-access');
  return {
    directory,
    config: path.join(directory, 'config.json'),
    log: path.join(directory, 'tunnel.log'),
    plist: path.join(home, 'Library/LaunchAgents', `${label}.plist`),
    sshConfig: path.join(directory, 'mac-ssh.conf'),
  };
}

function port(value, minimum, name) {
  if (!Number.isInteger(value) || value < minimum || value > 65535) {
    throw new Error(`${name} must be an integer from ${minimum} to 65535.`);
  }
  return value;
}

export function validateConfig(input) {
  if (!input || input.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.host ?? '')) {
    throw new Error('Use version 1 and an SSH host alias without spaces or options.');
  }
  if (!input.services || Object.keys(input.services).some(name => !serviceNames.includes(name))) {
    throw new Error(`services may contain only ${serviceNames.join(', ')}.`);
  }
  const services = {};
  const macListeners = new Set();
  const wslListeners = new Set();
  for (const name of serviceNames) {
    const service = input.services[name];
    if (service === undefined || service === false) continue;
    const localPort = port(service.localPort, name === 'macLogin' ? 1 : 1024, `${name}.localPort`);
    const remotePort = port(service.remotePort, 1024, `${name}.remotePort`);
    // Browser's Mac relay is also a listener, and app/Executor targets already
    // occupy their WSL ports. No service may reuse another service's endpoint.
    if (macListeners.has(localPort) || wslListeners.has(remotePort)) throw new Error('Duplicate service endpoint port.');
    macListeners.add(localPort); wslListeners.add(remotePort);
    services[name] = { localPort, remotePort };
    if (name === 'browser') {
      if (typeof service.profile !== 'string' || !path.isAbsolute(service.profile) || /[\r\n\0]/.test(service.profile)) {
        throw new Error('browser.profile must be the absolute path to your existing Helium profile.');
      }
      services[name].profile = service.profile;
      if (service.shared !== undefined && typeof service.shared !== 'boolean') throw new Error('browser.shared must be boolean.');
      services[name].shared = service.shared ?? false;
    }
    if (name === 'macLogin') {
      if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(service.user ?? '')) {
        throw new Error('macLogin.user must be your Mac account username.');
      }
      services[name].user = service.user;
    }
  }
  if (!Object.keys(services).length) throw new Error('Enable at least one service.');
  const replaceAgents = input.replaceAgents ?? [];
  if (!Array.isArray(replaceAgents) || replaceAgents.some(agent =>
    typeof agent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent) || agent === label)) {
    throw new Error('replaceAgents must contain other LaunchAgent labels, without paths.');
  }
  return { version: 1, host: input.host, services, replaceAgents: [...new Set(replaceAgents)] };
}

export function defaultConfig(host, macLogin = false) {
  return validateConfig({
    version: 1, host,
    services: {
      app: { localPort: 8080, remotePort: 8080 },
      browser: { localPort: 19222, remotePort: 9223, shared: true, profile: path.join(homedir(), 'Library/Application Support/net.imput.helium') },
      ...(macLogin ? { macLogin: { localPort: 22, remotePort: 2222, user: userInfo().username } } : {}),
    },
  });
}

export function sshArgs(config) {
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none', '-o', 'GatewayPorts=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
  for (const [name, service] of Object.entries(config.services)) {
    const local = ['app', 'executor'].includes(name);
    args.push(local ? '-L' : '-R', local
      ? `127.0.0.1:${service.localPort}:127.0.0.1:${service.remotePort}`
      : `127.0.0.1:${service.remotePort}:127.0.0.1:${service.localPort}`);
  }
  args.push(config.host);
  return args;
}

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function connectionConfig(resolved, home = homedir()) {
  // Resolve the user's alias once, preserving connection/authentication options
  // while removing inherited forwards that could duplicate or expose listeners.
  const excluded = new Set(['host', 'localforward', 'remoteforward', 'dynamicforward',
    'clearallforwardings', 'controlmaster', 'controlpath', 'controlpersist',
    'remotecommand', 'localcommand', 'permitlocalcommand']);
  const host = resolved.split('\n').find(line => line.startsWith('host '))?.slice(5);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host ?? '')) throw new Error('ssh -G did not resolve a valid host alias.');
  const lines = resolved.trim().split('\n').filter(line => !excluded.has(line.split(' ')[0].toLowerCase()));
  // Jump hosts still use the user's original configuration; the target's
  // resolved block never imports its old forwards.
  return `Host ${host}\n${lines.map(line => `  ${line}`).join('\n')}\nHost !${host} *\n  Include ${JSON.stringify(path.join(home, '.ssh/config'))}\n`;
}

export function tunnelPlist(config, paths, node = process.execPath) {
  const args = [node, path.join(paths.directory, 'runtime/worker.mjs'), paths.directory];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(paths.log)}</string>
<key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict></plist>
`;
}
