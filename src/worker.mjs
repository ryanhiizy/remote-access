import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { shellQuote, sshArgs, validateConfig } from './config.mjs';

export function readEndpoint(profile) {
  try {
    const [port, websocket, extra] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    if (extra !== undefined || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
      || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(websocket ?? '')) return null;
    return { port: Number(port), path: websocket };
  } catch { return null; }
}

export function browserRelay(profile) {
  const sockets = new Set();
  const server = createServer(client => {
    const endpoint = readEndpoint(profile);
    if (!endpoint) { client.destroy(); return; }
    const target = createConnection({ host: '127.0.0.1', port: endpoint.port });
    sockets.add(client); sockets.add(target);
    const close = () => { client.destroy(); target.destroy(); sockets.delete(client); sockets.delete(target); };
    client.on('error', close); target.on('error', close);
    client.on('close', close); target.on('close', close);
    client.pipe(target); target.pipe(client);
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

export function remoteCommand(browser) {
  if (!browser) return "printf 'REMOTE_ACCESS_READY\\n'; cat >/dev/null";
  // Metadata is the only browser data copied. WSL's existing --autoConnect
  // integration uses this mirror; the real signed-in profile stays on the Mac.
  const code = `import json, os, pathlib, re, sys
root = pathlib.Path.home() / '.local/share/codex-browser/mac-profile'
root.mkdir(parents=True, exist_ok=True)
os.umask(0o077)
root.chmod(0o700)
print('REMOTE_ACCESS_READY', flush=True)
for line in sys.stdin:
    value = json.loads(line)
    if value is None:
        (root / 'DevToolsActivePort').unlink(missing_ok=True)
        continue
    if not re.fullmatch(r'/devtools/browser/[A-Za-z0-9-]+', value['path']):
        raise ValueError('Invalid browser endpoint')
    temporary = root / ('DevToolsActivePort.' + str(os.getpid()))
    temporary.write_text('${browser.remotePort}\\n' + value['path'] + '\\n')
    temporary.replace(root / 'DevToolsActivePort')
`;
  return `python3 -u -c ${shellQuote(code)}`;
}

export async function supervise(directory) {
  const config = validateConfig(JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8')));
  const stateFile = path.join(directory, 'state.json');
  let child = null;
  let stopped = false;
  let wake = null;
  const record = state => {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ state, pid: process.pid, updated: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, stateFile);
    console.log(`${new Date().toISOString()} ${state}`);
  };
  const stop = () => { stopped = true; child?.kill('SIGTERM'); wake?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const relay = config.services.browser ? browserRelay(config.services.browser.profile) : null;
  if (relay) {
    await new Promise((resolve, reject) => {
      relay.server.once('error', reject);
      relay.server.listen(config.services.browser.localPort, '127.0.0.1', resolve);
    });
  }
  try {
    while (!stopped) {
      record('connecting');
      const args = ['-F', path.join(directory, 'tunnel-ssh.conf'), ...sshArgs(config).filter(arg => arg !== '-N'), remoteCommand(config.services.browser)];
      child = spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'inherit'] });
      let ready = false;
      let output = '';
      let previous;
      const publish = () => {
        if (!ready || !config.services.browser) return;
        const endpoint = readEndpoint(config.services.browser.profile);
        const value = JSON.stringify(endpoint ? { path: endpoint.path } : null);
        if (value !== previous && !child.stdin.destroyed) {
          previous = value;
          child.stdin.write(`${value}\n`);
        }
      };
      child.stdin.on('error', error => { console.error(error.message); child?.kill('SIGTERM'); });
      child.stdout.on('data', bytes => {
        output = `${output}${bytes}`.slice(-4096);
        if (!ready && output.includes('REMOTE_ACCESS_READY')) { ready = true; record('connected'); publish(); }
      });
      const timer = setInterval(publish, 1000);
      const startup = setTimeout(() => { if (!ready) { console.error('SSH readiness timed out'); child?.kill('SIGTERM'); } }, 20000);
      await new Promise(resolve => {
        child.once('error', error => { console.error(error.message); resolve(); });
        child.once('close', resolve);
      });
      clearInterval(timer); clearTimeout(startup);
      child = null;
      if (!stopped) {
        record('reconnecting');
        await new Promise(resolve => { const timer = setTimeout(resolve, 3000); wake = () => { clearTimeout(timer); resolve(); }; });
        wake = null;
      }
    }
  } finally {
    relay?.close(); record('stopped');
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1]?.endsWith('/worker.mjs')) {
  try { await supervise(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
