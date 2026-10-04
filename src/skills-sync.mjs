// Keeps agent skills identical on WSL and the Mac. Runs only when invoked.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

// Shared skills live in ~/.agents/skills. Agents do not read that directory
// at user level, so each agent directory links to every shared skill and
// keeps only its own real skill directories. Built-in/app-managed sets
// (.codex/skills/.system, .claude/skills/synced) are never synced.
const roots = ['.agents/skills', '.codex/skills', '.claude/skills'];
const files = ['.agents/.skill-lock.json'];
const managed = new Set(['.codex/skills/.system', '.claude/skills/synced']);
const ignored = new Set(['.DS_Store', '__pycache__']);
const placeholder = '\u0000REMOTE_ACCESS_HOME\u0000';

export const linkScript = `set -eu
cd "$HOME"
for agent in .claude/skills .codex/skills; do
  mkdir -p "$agent"
  for entry in "$agent"/*; do
    if [ -L "$entry" ] && [ ! -e "$entry" ]; then rm "$entry"; echo "removed dangling $entry"; fi
  done
  for dir in .agents/skills/*/; do
    [ -d "$dir" ] || continue
    name=\${dir%/}; name=\${name##*/}
    target="../../.agents/skills/$name"; entry="$agent/$name"
    if [ -L "$entry" ]; then
      if [ "$(readlink "$entry")" != "$target" ]; then rm "$entry"; ln -s "$target" "$entry"; echo "relinked $entry"; fi
    elif [ -e "$entry" ]; then echo "warning: $entry is an agent-specific copy that hides the shared skill"
    else ln -s "$target" "$entry"; echo "linked $entry"; fi
  done
done
`;

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function textOf(buffer) {
  if (buffer.includes(0)) return null;
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null;
}

// Items are whole skill directories or single files, keyed by home-relative path.
export function items(root) {
  const found = new Map();
  for (const file of files) {
    try { if (lstatSync(path.join(root, file)).isFile()) found.set(file, 'file'); } catch { /* absent */ }
  }
  for (const directory of roots) {
    let entries = [];
    try { entries = readdirSync(path.join(root, directory), { withFileTypes: true }); } catch { /* absent */ }
    for (const entry of entries) {
      const key = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !managed.has(key) && !ignored.has(entry.name)) found.set(key, 'dir');
    }
  }
  return found;
}

// Content hash with the machine's home directory normalized away, so the
// same skill on /Users/... and /home/... compares equal.
export function fingerprint(root, key, home) {
  const lines = [];
  const visit = relative => {
    const absolute = path.join(root, key, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) lines.push(`l ${relative} ${readlinkSync(absolute).replaceAll(home, placeholder)}`);
    else if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) if (!ignored.has(name)) visit(path.join(relative, name));
    } else {
      const buffer = readFileSync(absolute);
      const text = textOf(buffer);
      const digest = createHash('sha256').update(text === null ? buffer : text.replaceAll(home, placeholder)).digest('hex');
      lines.push(`f ${relative} ${stat.mode & 0o111 ? 'x' : '-'} ${digest}`);
    }
  };
  visit('');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Copy rewriting home paths in text files and symlink targets.
export function copyTree(source, target, from, to) {
  const stat = lstatSync(source);
  mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source).replaceAll(from, to), target);
  else if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) if (!ignored.has(name)) copyTree(path.join(source, name), path.join(target, name), from, to);
  } else {
    const buffer = readFileSync(source);
    const text = textOf(buffer);
    if (text === null) copyFileSync(source, target);
    else writeFileSync(target, text.replaceAll(from, to));
    chmodSync(target, stat.mode & 0o777);
  }
}

// Three-way decision against the state recorded after the last sync.
export function plan(local, remote, base, prefer) {
  const actions = [];
  for (const key of new Set([...Object.keys(base), ...local.keys(), ...remote.keys()])) {
    const l = local.get(key) ?? null;
    const r = remote.get(key) ?? null;
    const b = key in base ? base[key] : undefined;
    if (l === r) actions.push({ key, action: 'same', value: l });
    else if ((b !== undefined && l === b) || (b === undefined && l === null)) actions.push({ key, action: 'pull', value: r });
    else if ((b !== undefined && r === b) || (b === undefined && r === null)) actions.push({ key, action: 'push', value: l });
    else if (prefer === 'mac') actions.push({ key, action: 'pull', value: r });
    else if (prefer === 'wsl') actions.push({ key, action: 'push', value: l });
    else actions.push({ key, action: 'conflict' });
  }
  return actions.sort((a, b) => a.key.localeCompare(b.key));
}

function ssh(sshConfig, command, { input, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', ['-T', '-F', sshConfig, 'mac-remote', command], { stdio });
    const chunks = [];
    let error = '';
    child.stdout?.on('data', chunk => chunks.push(chunk));
    child.stderr?.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks))
      : reject(new Error(`Mac command failed (${code}): ${error.trim().split('\n').at(-1) ?? ''}`)));
    if (input) input.pipe(child.stdin); else child.stdin?.end();
  });
}

function tar(args, options = {}) {
  const result = spawnSync('tar', args, { maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr?.toString().trim()}`);
  return result.stdout;
}

const snapshotScript = `set -eu
cd "$HOME"
set --
for p in ${[...roots, ...files].join(' ')}; do if [ -e "$p" ]; then set -- "$@" "$p"; fi; done
COPYFILE_DISABLE=1 exec tar --no-xattrs --no-mac-metadata ${[...ignored].map(name => `--exclude ${quote(name)}`).join(' ')} ${[...managed].map(name => `--exclude ${quote(name)}`).join(' ')} -cf - "$@"
`;

function lock(file) {
  try { mkdirSync(file); }
  catch {
    // A crashed run leaves its lock behind; ten minutes exceeds any real sync.
    if (Date.now() - statSync(file).mtimeMs < 10 * 60 * 1000) throw new Error('Another skills sync is running.');
    rmSync(file, { recursive: true, force: true }); mkdirSync(file);
  }
  return () => rmSync(file, { recursive: true, force: true });
}

export async function syncSkills({ home = homedir(), dryRun = false, prefer, log = console.log } = {}) {
  const directory = path.join(home, '.config/remote-access');
  const config = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));
  const sshConfig = path.join(directory, 'mac-ssh.conf');
  if (!config.services?.macLogin || !existsSync(sshConfig)) throw new Error('Skills sync requires Mac Remote Login (macLogin).');
  const macHome = `/Users/${config.services.macLogin.user}`;
  const stateFile = path.join(directory, 'skills-sync-state.json');
  const unlock = lock(path.join(directory, 'skills-sync.lock'));
  const work = mkdtempSync(path.join(directory, 'skills-sync-'));
  try {
    const snapshot = await ssh(sshConfig, `/bin/sh -c ${quote(snapshotScript)}`);
    const mac = path.join(work, 'mac');
    mkdirSync(mac);
    tar(['-x', '--warning=no-unknown-keyword', '-f', '-', '-C', mac], { input: snapshot });
    const hashes = (root, own) => new Map([...items(root).keys()].map(key => [key, fingerprint(root, key, own)]));
    const local = hashes(home, home);
    const remote = hashes(mac, macHome);
    const base = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).items : {};
    const actions = plan(local, remote, base, prefer);
    const changes = actions.filter(item => item.action !== 'same');
    for (const item of changes) {
      const verb = item.action === 'conflict' ? 'conflict (changed on both; rerun with --prefer mac or --prefer wsl)'
        : item.action === 'pull' ? (item.value === null ? 'delete on WSL' : 'Mac → WSL')
          : (item.value === null ? 'delete on Mac' : 'WSL → Mac');
      log(`${dryRun ? 'would ' : ''}${verb}: ${item.key}`);
    }
    if (dryRun) return { changes: changes.length, conflicts: changes.filter(item => item.action === 'conflict').length };

    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const backup = path.join(directory, 'backups', `skills-sync-${stamp}`);
    for (const item of changes.filter(change => change.action === 'pull')) {
      const target = path.join(home, item.key);
      if (existsSync(target)) {
        mkdirSync(path.dirname(path.join(backup, item.key)), { recursive: true });
        renameSync(target, path.join(backup, item.key));
      }
      if (item.value !== null) copyTree(path.join(mac, item.key), target, macHome, home);
    }
    const pushes = changes.filter(change => change.action === 'push');
    if (pushes.length) {
      const staging = path.join(work, 'push');
      const present = pushes.filter(item => item.value !== null).map(item => item.key);
      for (const key of present) copyTree(path.join(home, key), path.join(staging, key), home, macHome);
      const script = `set -eu
cd "$HOME"
backup="$HOME/Library/Application Support/remote-access/backups/skills-sync-${stamp}"
for p in ${pushes.map(item => quote(item.key)).join(' ')}; do
  if [ -e "$p" ] || [ -L "$p" ]; then mkdir -p "$backup/$(dirname "$p")"; mv "$p" "$backup/$p"; fi
done
${present.length ? 'tar -xf -' : 'cat >/dev/null'}
`;
      const archive = present.length ? spawn('tar', ['-cf', '-', '-C', staging, ...present]).stdout : undefined;
      await ssh(sshConfig, `/bin/sh -c ${quote(script)}`, { input: archive });
    }
    const merged = Object.fromEntries(actions.filter(item => item.action !== 'conflict' && item.value !== null)
      .map(item => [item.key, item.value]));
    for (const item of actions.filter(change => change.action === 'conflict')) if (item.key in base) merged[item.key] = base[item.key];
    writeFileSync(stateFile, `${JSON.stringify({ version: 1, synced: new Date().toISOString(), items: merged }, null, 2)}\n`, { mode: 0o600 });

    const links = spawnSync('/bin/sh', ['-s'], { input: linkScript, encoding: 'utf8' });
    if (links.status !== 0) throw new Error(`Linking WSL skills failed: ${links.stderr.trim()}`);
    const macLinks = (await ssh(sshConfig, `/bin/sh -c ${quote(linkScript)}`)).toString();
    for (const line of `${links.stdout}${macLinks}`.trim().split('\n').filter(Boolean)) log(line);
    if (!changes.length) log('Skills already in sync.');
    return { changes: changes.length, conflicts: changes.filter(item => item.action === 'conflict').length };
  } finally {
    rmSync(work, { recursive: true, force: true });
    unlock();
  }
}

export async function main(args) {
  const usage = 'Usage: remote-access skills-sync [--dry-run] [--prefer mac|wsl]';
  if (process.platform !== 'linux') throw new Error('Run skills-sync on the remote Linux machine.');
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      'dry-run': { type: 'boolean' }, prefer: { type: 'string' },
    } }));
  } catch { throw new Error(usage); }
  if (values.prefer !== undefined && !['mac', 'wsl'].includes(values.prefer)) throw new Error(usage);
  const result = await syncSkills({ dryRun: values['dry-run'], prefer: values.prefer });
  if (result.conflicts) process.exitCode = 1;
}

