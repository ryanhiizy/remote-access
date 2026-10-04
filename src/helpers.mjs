import { existsSync, readFileSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './config.mjs';

export function installHelpers({ home = homedir(), platform = process.platform, node = process.execPath } = {}) {
  if (platform !== 'linux') throw new Error('Install helpers on the remote Linux machine; Helium and the clipboard stay on your Mac.');
  const directory = path.join(home, '.config/remote-access');
  const config = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));
  const sshConfig = path.join(directory, 'mac-ssh.conf');
  if (!config.services?.macLogin || !existsSync(sshConfig)) {
    throw new Error('Install the Mac connection with macLogin enabled first.');
  }
  const bin = path.join(home, '.local/bin');
  const backup = path.join(directory, 'backups', `helpers-${Date.now()}-${process.pid}`);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const save = (file, text, executable = false) => {
    const name = path.relative(home, file).replaceAll('/', '_');
    if (existsSync(file)) copyFileSync(file, path.join(backup, name));
    else writeFileSync(path.join(backup, `${name}.absent`), '', { mode: 0o600 });
    writeFileSync(file, text, { mode: executable ? 0o700 : 0o600 });
    chmodSync(file, executable ? 0o700 : 0o600);
  };
  const opener = path.join(directory, 'browser-open.mjs');
  save(opener, readFileSync(fileURLToPath(new URL('./browser-open.mjs', import.meta.url)), 'utf8'));
  const invoke = `exec ${shellQuote(node)} ${shellQuote(opener)} "$@"`;
  for (const name of ['remote-access-browser', 'sensible-browser', 'www-browser']) {
    save(path.join(bin, name), `#!/bin/sh\n${invoke}\n`, true);
  }
  // Web URLs, file URLs and existing paths open on the Mac; anything else
  // (e.g. mailto:) continues to the system helper.
  save(path.join(bin, 'xdg-open'), `#!/bin/sh
case "$1" in
  http://*|https://*|file://*) ${invoke} ;;
esac
if [ "$#" -eq 1 ] && [ -e "$1" ]; then ${invoke}; fi
exec /usr/bin/xdg-open "$@"
`, true);
  // UTF-8 so non-ASCII text survives the non-interactive SSH session.
  const ssh = command => `#!/bin/sh\nexec /usr/bin/ssh -T -F ${shellQuote(sshConfig)} mac-remote ${shellQuote(`LANG=en_US.UTF-8 ${command}`)}\n`;
  save(path.join(bin, 'pbcopy'), ssh('/usr/bin/pbcopy'), true);
  save(path.join(bin, 'pbpaste'), ssh('/usr/bin/pbpaste'), true);
  return {
    backup, browser: path.join(bin, 'remote-access-browser'), opener,
    helpers: ['xdg-open', 'sensible-browser', 'www-browser', 'pbcopy', 'pbpaste'],
  };
}
