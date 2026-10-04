import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locations, shellQuote } from './config.mjs';

function macSetup(home) {
  const paths = locations(home, 'linux');
  const config = JSON.parse(readFileSync(paths.config, 'utf8'));
  if (!config.services?.macLogin || !existsSync(paths.sshConfig)) throw new Error('Install on the Mac with macLogin enabled first.');
  return { ...paths, macHome: `/Users/${config.services.macLogin.user}` };
}

const write = (file, text, mode = 0o700) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
};

export function installHelpers({ home = homedir(), node = process.execPath } = {}) {
  if (process.platform !== 'linux') throw new Error('Install helpers on the remote Linux machine.');
  const { directory, sshConfig, macHome } = macSetup(home);
  const bin = path.join(home, '.local/bin');
  // Snapshot the dependency-free opener so the helpers survive moving this checkout.
  const opener = path.join(directory, 'browser-open.mjs');
  write(opener, readFileSync(fileURLToPath(new URL('./browser-open.mjs', import.meta.url))), 0o600);
  const invoke = `exec ${shellQuote(node)} ${shellQuote(opener)} "$@"`;
  for (const name of ['remote-access-browser', 'sensible-browser', 'www-browser']) write(path.join(bin, name), `#!/bin/sh\n${invoke}\n`);
  // Web URLs, file URLs and existing paths open on the Mac; anything else goes to the system helper.
  write(path.join(bin, 'xdg-open'), `#!/bin/sh
case "$1" in http://*|https://*|file://*) ${invoke} ;; esac
if [ "$#" -eq 1 ] && [ -e "$1" ]; then ${invoke}; fi
exec /usr/bin/xdg-open "$@"
`);
  // UTF-8 so non-ASCII text survives the non-interactive SSH session.
  const mac = command => `#!/bin/sh\nexec /usr/bin/ssh -T -F ${shellQuote(sshConfig)} mac-remote ${shellQuote(`LANG=en_US.UTF-8 ${command}`)}\n`;
  write(path.join(bin, 'pbcopy'), mac('/usr/bin/pbcopy'));
  write(path.join(bin, 'pbpaste'), mac('/usr/bin/pbpaste'));
  // Unison profile for skills-sync. Skills must use ~ rather than absolute home paths.
  write(path.join(home, '.unison/skills.prf'), `root = ${home}
root = ssh://mac-remote/${macHome}
path = .agents
path = .claude/skills
path = .codex/skills
ignore = Name .DS_Store
ignore = Name __pycache__
ignore = Path .codex/skills/.system
ignore = Path .claude/skills/synced
links = true
perms = 0o111
sshargs = -F ${sshConfig}
servercmd = /opt/homebrew/bin/unison
`, 0o600);
  return { browser: path.join(bin, 'remote-access-browser'), helpers: ['xdg-open', 'sensible-browser', 'www-browser', 'pbcopy', 'pbpaste'], unison: '~/.unison/skills.prf' };
}

export function skillsSync(args, home = homedir()) {
  if (args.length && !(args.length === 2 && args[0] === '--prefer' && ['mac', 'wsl'].includes(args[1]))) {
    throw new Error('Usage: remote-access skills-sync [--prefer mac|wsl]');
  }
  const { macHome } = macSetup(home);
  const prefer = args[1] ? ['-prefer', args[1] === 'wsl' ? home : `ssh://mac-remote/${macHome}`] : [];
  const result = spawnSync('unison', ['skills', '-batch', '-terse', ...prefer], { stdio: 'inherit' });
  if (result.error) throw new Error('Install Unison 2.52+ on both machines (brew install unison).');
  // Unison exits 1 when it skipped conflicts; rerun with --prefer to resolve.
  process.exitCode = result.status;
}
