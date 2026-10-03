#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function browserUrl(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Pass one HTTP or HTTPS URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Pass one HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS URLs without embedded credentials can open in Helium.');
  }
  return url.href;
}

export function macOpenScript(value) {
  const url = browserUrl(value);
  const quoted = `'${url.replaceAll("'", "'\\''")}'`;
  // Native URL opening leaves the tab owned by the user, independent of an
  // ephemeral MCP client's lifecycle. Do not print callback URLs or tokens.
  return `set -eu\n/usr/bin/pgrep -x Helium >/dev/null || exit 3\n/usr/bin/open -a Helium ${quoted}\n`;
}

export async function openBrowser(value, { directory = path.join(homedir(), '.config/remote-access'), timeout = 15000, execute = spawn } = {}) {
  const script = macOpenScript(value);
  const config = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));
  const sshConfig = path.join(directory, 'mac-ssh.conf');
  if (!config.services?.macLogin || !existsSync(sshConfig)) {
    throw new Error('Mac Remote Login is required for URL opening. Enable macLogin and install remote-access on your Mac.');
  }
  await new Promise((resolve, reject) => {
    const child = execute('/usr/bin/ssh', ['-T', '-F', sshConfig, 'mac-remote', '/bin/sh -s'], { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Mac browser request timed out. Check remote-access status before retrying; the URL is not replayed automatically.'));
    }, timeout);
    child.once('error', () => finish(new Error('Unable to reach your Mac browser. Check remote-access status.')));
    child.once('close', code => {
      if (code === 0) finish();
      else if (code === 3) finish(new Error('Helium is not running on your Mac. Start Helium, then retry.'));
      else finish(new Error('Mac URL opening failed. Check remote-access status and Mac Remote Login.'));
    });
    child.stdin.once('error', () => finish(new Error('Mac connection closed before confirming URL opening.')));
    child.stdin.end(script);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('Usage: remote-access-browser HTTP_OR_HTTPS_URL'); process.exitCode = 1; }
  else {
    try { await openBrowser(process.argv[2]); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
