import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export const label = 'io.github.ryanhiizy.remote-access';
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

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

// host: the WSL machine's Tailscale name (or an SSH alias for it).
// windows: optional Windows OpenSSH on the same machine, the way in when WSL is down.
export function validateConfig(input) {
  if (input?.version !== 1 || !hostname.test(input.host ?? '')) {
    throw new Error('Use version 1 and host set to the WSL Tailscale name.');
  }
  const { app, macLogin } = input.services ?? {};
  const services = {};
  if (app) services.app = { localPort: port(app.localPort, 1024, 'app.localPort'), remotePort: port(app.remotePort, 1024, 'app.remotePort') };
  // WSL reaches the Mac's own sshd directly over Tailscale; no forward needed.
  if (macLogin) {
    if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(macLogin.user ?? '') || !hostname.test(macLogin.address ?? '')) {
      throw new Error('macLogin needs user (Mac username) and address (Mac Tailscale name).');
    }
    services.macLogin = { user: macLogin.user, address: macLogin.address };
  }
  if (!services.app && !services.macLogin) throw new Error('Enable app, macLogin or both.');
  if (!input.windows) return { version: 1, host: input.host, services };
  const windows = { host: input.windows.host ?? input.host, port: port(input.windows.port ?? 2222, 1, 'windows.port') };
  if (!hostname.test(windows.host)) throw new Error('windows.host must be the Windows Tailscale name or an SSH alias.');
  // Mirrored networking shares ports with WSL, whose sshd owns 22.
  if (windows.port === 22) throw new Error('windows.port must not be 22; WSL sshd uses it.');
  return { version: 1, host: input.host, services, windows };
}

export function defaultConfig(host, macAddress) {
  return validateConfig({
    version: 1, host,
    services: {
      app: { localPort: 8080, remotePort: 8080 },
      ...(macAddress ? { macLogin: { user: userInfo().username, address: macAddress } } : {}),
    },
  });
}


// launchd restarts ssh on exit; ServerAlive and ExitOnForwardFailure make it
// exit on a dead link or a taken port, so no supervisor process is needed.
export function sshArgs(config) {
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'GatewayPorts=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  const { app } = config.services;
  if (app) args.push('-L', `127.0.0.1:${app.localPort}:127.0.0.1:${app.remotePort}`);
  return [...args, config.host];
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
