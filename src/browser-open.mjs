#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function browserUrl(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Pass one HTTP or HTTPS URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Pass one HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS URLs without embedded credentials can open in Helium.');
  }
  return url.href;
}

// A web URL opens in Helium; anything else must name an existing local path.
export function openTarget(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Pass one URL or path.');
  if (/^https?:/i.test(value)) return { url: browserUrl(value) };
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  try { lstatSync(file); } catch { throw new Error('Pass an HTTP(S) URL or an existing file or directory.'); }
  return { file };
}

export function macOpenScript(value) {
  // Native URL opening leaves the tab owned by the user, independent of an
  // ephemeral MCP client's lifecycle. Do not print callback URLs or tokens.
  return `set -eu\n/usr/bin/pgrep -x Helium >/dev/null || exit 3\n/usr/bin/open -a Helium ${quote(browserUrl(value))}\n`;
}

// Files are copied (not shared) into ~/Downloads/WSL and opened with their
// default Mac app. Existing copies are kept; a new name is chosen instead.
export function macFileScript(name) {
  return `set -eu
dest="$HOME/Downloads/WSL"
mkdir -p "$dest"
incoming=$(mktemp -d "$dest/.incoming.XXXXXX")
trap 'rm -rf "$incoming"' EXIT
tar -xf - -C "$incoming"
name=${quote(name)}
case "$name" in ?*.*) stem=\${name%.*}; ext=.\${name##*.} ;; *) stem=$name; ext= ;; esac
target="$dest/$name"; n=2
while [ -e "$target" ] || [ -L "$target" ]; do target="$dest/$stem ($n)$ext"; n=$((n + 1)); done
mv "$incoming/$name" "$target"
/usr/bin/open "$target"
printf '%s\\n' "$target"
`;
}

export async function openOnMac(value, { directory = path.join(homedir(), '.config/remote-access'), timeout = 15000, execute = spawn, log = console.log } = {}) {
  const target = openTarget(value);
  const config = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));
  const sshConfig = path.join(directory, 'mac-ssh.conf');
  if (!config.services?.macLogin || !existsSync(sshConfig)) {
    throw new Error('Mac Remote Login is required for opening on the Mac. Enable macLogin and install remote-access on your Mac.');
  }
  await new Promise((resolve, reject) => {
    const script = target.url ? macOpenScript(target.url) : macFileScript(path.basename(target.file));
    const child = execute('/usr/bin/ssh', ['-T', '-F', sshConfig, config.services.macLogin.address, target.url ? '/bin/sh -s' : `/bin/sh -c ${quote(script)}`],
      { stdio: ['pipe', target.url ? 'ignore' : 'pipe', 'ignore'] });
    const archive = target.file
      ? execute('tar', ['-ch', '-f', '-', '-C', path.dirname(target.file), path.basename(target.file)], { stdio: ['ignore', 'pipe', 'ignore'] })
      : null;
    let settled = false;
    let output = '';
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    };
    // File transfers take as long as they take; only URL dispatch is bounded.
    const deadline = target.url ? setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Mac browser request timed out. Check remote-access status before retrying; the URL is not replayed automatically.'));
    }, timeout) : null;
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', () => finish(new Error('Unable to reach your Mac. Check remote-access status.')));
    archive?.once('error', () => finish(new Error('Unable to read the file for transfer.')));
    child.once('close', code => {
      if (code === 0) { if (target.file) log(`Opened on Mac: ${output.trim()}`); finish(); }
      else if (code === 3) finish(new Error('Helium is not running on your Mac. Start Helium, then retry.'));
      else finish(new Error(target.url ? 'Mac URL opening failed. Check remote-access status and Mac Remote Login.'
        : 'Copying or opening the file on the Mac failed. Check remote-access status and Mac Remote Login.'));
    });
    child.stdin.once('error', () => finish(new Error('Mac connection closed before confirming.')));
    if (archive) archive.stdout.pipe(child.stdin);
    else child.stdin.end(script);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('Usage: remote-access-browser URL_OR_PATH'); process.exitCode = 1; }
  else {
    try { await openOnMac(process.argv[2]); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
