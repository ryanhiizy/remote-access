import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { locations, validateConfig } from './config.mjs';

// Transfer finalized clips over the existing pinned-key SSH connection, rather
// than exposing videos on a web server or sending base64 through MCP.
export async function fetchRecording([action, id, destination, ...extra], home = homedir()) {
  if (action !== 'fetch' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id ?? '') || extra.length) {
    throw new Error('Usage: remote-access recording fetch RECORDING_ID [DESTINATION.webm]');
  }
  const paths = locations(home);
  const macSource = join(paths.directory, 'recordings', `${id}.webm`);
  // On the Mac the recording is already in its canonical location.
  if (process.platform === 'darwin' && destination === undefined) {
    if (!(await stat(macSource)).size) throw new Error('The recording is empty.');
    return macSource;
  }
  const savedDirectory = join(home, '.local/share/remote-access/recordings');
  const target = destination === undefined ? join(savedDirectory, `${id}.webm`) : resolve(destination);
  const temporary = await mkdtemp(join(tmpdir(), 'remote-access-video-'));
  const download = join(temporary, `${id}.webm`);
  try {
    if (process.platform === 'darwin') {
      await copyFile(macSource, download);
    } else {
      const config = validateConfig(JSON.parse(readFileSync(paths.config, 'utf8')));
      const mac = config.services.macLogin;
      if (!mac) throw new Error('Enable macLogin and install remote-access on your Mac first.');
      const source = `/Users/${mac.user}/Library/Application Support/remote-access/recordings/${id}.webm`;
      const copied = spawnSync('/usr/bin/scp', ['-q', '-F', paths.sshConfig, `${mac.address}:${source}`, download], { encoding: 'utf8', timeout: 120000 });
      if (copied.error || copied.status !== 0) throw new Error(`Could not fetch saved recording: ${copied.error?.message ?? copied.stderr.trim()}. Stop the recording before fetching it.`);
    }
    if (!(await stat(download)).size) throw new Error('The recording is empty.');
    if (destination === undefined) await mkdir(savedDirectory, { recursive: true, mode: 0o700 });
    // A failed transfer never leaves a partial destination or overwrites a file.
    await copyFile(download, target, constants.COPYFILE_EXCL);
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
