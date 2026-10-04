#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultConfig, label, locations, shellQuote, tunnelPlist, validateConfig } from '../src/config.mjs';
import { install, inventory, privateWrite, run, start, status, stop } from '../src/manager.mjs';
import { openOnMac } from '../src/browser-open.mjs';
import { installHelpers } from '../src/helpers.mjs';
import { main as skillsSync } from '../src/skills-sync.mjs';

const help = `Usage: remote-access <command> [options]

  init --host SSH_ALIAS [--mac-login] [--replace LABEL]   Save personal configuration
  inspect                              List existing Mac tunnel LaunchAgents
  plan                                 Print proposed connection service
  install                              Install/migrate the configured Mac tunnels
  status [--json]                      Check tunnel and each enabled service
  start | stop | restart               Control the installed Mac connection
  logs                                 Show the last 60 tunnel log lines
  uninstall                            Stop and remove our LaunchAgent only
  mac -- COMMAND [ARG...]              Run a command on the Mac from WSL
  open URL_OR_PATH                     Open a URL in Mac Helium, or copy a file/folder to the Mac and open it
  install-helpers                      Route xdg-open/BROWSER and pbcopy/pbpaste to the Mac
  skills-sync [--dry-run] [--prefer mac|wsl]
                                       Sync agent skills with the Mac (run on WSL)

Options: --config FILE, --host SSH_ALIAS, --mac-login, --replace LABEL (repeatable), --json
Configuration defaults to the user's remote-access application-data directory.
Remote Login and broader disk permissions must be enabled on the Mac itself.
`;

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help' || (args[0] !== 'mac' && args.includes('--help'))) { console.log(help); return; }
  const command = args[0];
  if (command === 'open') {
    if (process.platform === 'darwin') throw new Error('Run open from the remote Linux machine.');
    const rest = args.slice(1);
    if (rest[0] === '--') rest.shift();
    if (rest.length !== 1) throw new Error('Usage: remote-access open URL_OR_PATH');
    await openOnMac(rest[0]);
    return;
  }
  if (command === 'install-helpers') {
    if (args.length !== 1) throw new Error('Usage: remote-access install-helpers');
    console.log(JSON.stringify(installHelpers(), null, 2));
    console.log('Keep ~/.local/bin on PATH. Set BROWSER to the reported browser executable for clients that use that variable.');
    return;
  }
  if (command === 'skills-sync') { await skillsSync(args.slice(1)); return; }
  if (command === 'mac') {
    if (process.platform === 'darwin') throw new Error('Run mac from WSL.');
    const rest = args.slice(1);
    if (rest[0] === '--') rest.shift();
    const file = locations().sshConfig;
    if (!existsSync(file)) throw new Error('Mac access is not configured. Install on the Mac with macLogin enabled first.');
    run('/usr/bin/ssh', ['-F', file, 'mac-remote', ...rest.map(shellQuote)], { stdio: 'inherit', timeout: undefined });
    return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, host: { type: 'string' },
    replace: { type: 'string', multiple: true },
    'mac-login': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  if (positionals.length !== 1) throw new Error(help);
  const paths = locations();
  const configFile = values.config ?? paths.config;
  if (command === 'init') {
    if (existsSync(configFile)) throw new Error(`Configuration already exists at ${configFile}. Edit it to change services or ports.`);
    const config = validateConfig({ ...defaultConfig(values.host ?? '', values['mac-login']), replaceAgents: values.replace ?? [] });
    privateWrite(configFile, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Saved ${configFile}. Run inspect, review the ports and replaceAgents, then install.`);
    return;
  }
  if (command === 'inspect') {
    if (process.platform !== 'darwin') throw new Error('Run inspect on your Mac.');
    console.log(JSON.stringify(inventory(), null, 2)); return;
  }
  if (['start', 'stop', 'restart', 'uninstall', 'logs'].includes(command)) {
    if (process.platform !== 'darwin') throw new Error(`Run ${command} on your Mac.`);
    if (command === 'logs') {
      console.log(existsSync(paths.log) ? readFileSync(paths.log, 'utf8').split('\n').slice(-60).join('\n') : 'No tunnel log yet.'); return;
    }
    if (['stop', 'restart', 'uninstall'].includes(command)) {
      try { stop(); } catch (error) {
        // Absence is harmless; do not suppress a failed stop of a loaded job.
        let loaded = false;
        try { run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]); loaded = true; } catch { /* absent */ }
        if (loaded) throw error;
      }
    }
    if (['start', 'restart'].includes(command)) start();
    if (command === 'uninstall') rmSync(paths.plist, { force: true });
    console.log(`${command} complete. Personal config, SSH authorization and migration backups are retained.`); return;
  }
  if (!['plan', 'install', 'status'].includes(command)) throw new Error(help);
  if (!existsSync(configFile)) throw new Error(`No configuration at ${configFile}. Run init --host YOUR_ALIAS first.`);
  const config = validateConfig(JSON.parse(readFileSync(configFile, 'utf8')));
  if (command === 'plan') { console.log(tunnelPlist(config, locations(undefined, 'darwin'))); return; }
  if (command === 'install') {
    console.log(JSON.stringify(await install(config), null, 2));
    console.log('Connection installed. Run status to check the backing services.'); return;
  }
  const report = await status(config);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.side}: ${report.host}${report.tunnel ? ` — tunnel ${report.tunnel}` : ''}`);
    for (const [name, state] of Object.entries(report.services)) console.log(`  ${name}: ${state}`);
    if (report.remoteError) console.log(`  remote check: ${report.remoteError}`);
    if (report.side === 'mac') console.log(`Log: ${report.log}`);
  }
  if (Object.values(report.services).some(state => !['ready', 'available'].includes(state)) || (report.tunnel && report.tunnel !== 'running')) process.exitCode = 1;
}

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
