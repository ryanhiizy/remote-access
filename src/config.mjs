import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

export const label = 'io.github.ryanhiizy.remote-access';
export const browserLabel = `${label}.browser`;
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function readEndpoint(profile) {
  try {
    const [port, websocket, extra] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    if (extra !== undefined || !/^\d+$/.test(port) || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(websocket ?? '')) return null;
    return { port: Number(port), path: websocket };
  } catch { return null; }
}

export function locations(home = homedir(), platform = process.platform) {
  const directory = platform === 'darwin'
    ? path.join(home, 'Library/Application Support/remote-access')
    : path.join(home, '.config/remote-access');
  return {
    directory,
    config: path.join(directory, 'config.json'),
    sshConfig: path.join(directory, 'mac-ssh.conf'),
    agents: path.join(home, 'Library/LaunchAgents'),
  };
}

function port(value, minimum, name) {
  if (!Number.isInteger(value) || value < minimum || value > 65535) throw new Error(`${name} must be an integer from ${minimum} to 65535.`);
  return value;
}

const hostname = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;

// host: SSH alias from the Mac to WSL. address (optional): overrides its
// HostName, e.g. the WSL machine's Tailscale name, keeping the alias's auth.
export function validateConfig(input) {
  if (input?.version !== 1 || !hostname.test(input.host ?? '')) {
    throw new Error('Use version 1 and an SSH host alias without spaces or options.');
  }
  const { app, browser, macLogin } = input.services ?? {};
  const services = {};
  if (app) services.app = { localPort: port(app.localPort, 1024, 'app.localPort'), remotePort: port(app.remotePort, 1024, 'app.remotePort') };
  if (browser) {
    if (typeof browser.profile !== 'string' || !path.isAbsolute(browser.profile) || /[\r\n\0]/.test(browser.profile)) {
      throw new Error('browser.profile must be the absolute path to your Helium profile.');
    }
    services.browser = { localPort: port(browser.localPort, 1024, 'browser.localPort'), remotePort: port(browser.remotePort, 1024, 'browser.remotePort'), profile: browser.profile };
  }
  // WSL reaches the Mac's own sshd directly over Tailscale; no forward needed.
  if (macLogin) {
    if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(macLogin.user ?? '') || !hostname.test(macLogin.address ?? '')) {
      throw new Error('macLogin needs user (Mac username) and address (Mac Tailscale name).');
    }
    services.macLogin = { user: macLogin.user, address: macLogin.address };
  }
  const forwards = [services.app, services.browser].filter(Boolean);
  if (!forwards.length && !services.macLogin) throw new Error('Enable at least one of app, browser and macLogin.');
  for (const side of ['localPort', 'remotePort']) {
    if (new Set(forwards.map(service => service[side])).size !== forwards.length) throw new Error('Duplicate service port.');
  }
  if (input.address !== undefined && !hostname.test(input.address)) throw new Error('address must be a hostname or IP.');
  return { version: 1, host: input.host, ...(input.address ? { address: input.address } : {}), services };
}

export function defaultConfig(host, macAddress) {
  return validateConfig({
    version: 1, host,
    services: {
      app: { localPort: 8080, remotePort: 8080 },
      browser: { localPort: 19222, remotePort: 9223, profile: path.join(homedir(), 'Library/Application Support/net.imput.helium') },
      ...(macAddress ? { macLogin: { user: userInfo().username, address: macAddress } } : {}),
    },
  });
}

export const hostArgs = config => (config.address ? ['-o', `HostName=${config.address}`] : []);

// launchd restarts ssh on exit; ServerAlive and ExitOnForwardFailure make it
// exit on a dead link or a taken port, so no supervisor process is needed.
export function sshArgs(config, sshConfig) {
  const args = ['-N', '-T', '-F', sshConfig, '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'GatewayPorts=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  const { app, browser } = config.services;
  if (app) args.push('-L', `127.0.0.1:${app.localPort}:127.0.0.1:${app.remotePort}`);
  if (browser) args.push('-R', `127.0.0.1:${browser.remotePort}:127.0.0.1:${browser.localPort}`);
  return [...args, config.host];
}

// Resolve the user's alias once, keeping connection/authentication options but
// dropping inherited forwards and multiplexing that could duplicate listeners.
export function connectionConfig(resolved, home = homedir()) {
  const excluded = new Set(['host', 'localforward', 'remoteforward', 'dynamicforward', 'clearallforwardings',
    'controlmaster', 'controlpath', 'controlpersist', 'remotecommand', 'localcommand', 'permitlocalcommand']);
  const host = resolved.split('\n').find(line => line.startsWith('host '))?.slice(5);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host ?? '')) throw new Error('ssh -G did not resolve a valid host alias.');
  const lines = resolved.trim().split('\n').filter(line => !excluded.has(line.split(' ')[0].toLowerCase()));
  return `Host ${host}\n${lines.map(line => `  ${line}`).join('\n')}\nHost !${host} *\n  Include ${JSON.stringify(path.join(home, '.ssh/config'))}\n`;
}

export const plist = (name, args, log) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${name}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
