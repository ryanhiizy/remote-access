#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency-free: install-helpers snapshots this beside the private SSH config.
export function asideCommand(user, args) {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user ?? '')) throw new Error('Invalid Mac username.');
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return ['exec', ...[`/Users/${user}/.local/bin/aside`, ...args].map(quote)].join(' ');
}

export function runAside(args, directory = path.join(homedir(), '.config/remote-access')) {
  const { services } = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));
  if (!services?.macLogin?.address) throw new Error('Enable Mac Remote Login and install remote-access first.');
  const child = spawn('/usr/bin/ssh', ['-T', '-F', path.join(directory, 'mac-ssh.conf'),
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    services.macLogin.address, asideCommand(services.macLogin.user, args)], { stdio: 'inherit' });
  // Keep MCP stdin/stdout untouched and terminate SSH when its client goes away.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('close', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runAside(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
