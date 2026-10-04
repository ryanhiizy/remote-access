#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultConfig, locations, shellQuote, validateConfig } from '../src/config.mjs';
import { install, privateWrite, start, status, stop, uninstall } from '../src/manager.mjs';
import { openOnMac } from '../src/browser-open.mjs';
import { gcloudLogin, installHelpers, skillsSync } from '../src/helpers.mjs';

const help = `Usage: remote-access <command>

Mac:  init --host WSL_TAILSCALE_NAME [--mac MAC_TAILSCALE_NAME] | install | start | stop | restart | logs | uninstall
WSL:  mac [-- COMMAND...] | open URL_OR_PATH | install-helpers | skills-sync [--prefer mac|wsl] | gcloud-login
Both: status [--json]   (nonzero when a service is unavailable)
`;

const mac = process.platform === 'darwin';
const only = (wanted, command) => { if (mac !== wanted) throw new Error(`Run ${command} on ${wanted ? 'the Mac' : 'WSL'}.`); };

export async function main([command, ...rest] = process.argv.slice(2)) {
  const paths = locations();
  const readConfig = () => {
    if (!existsSync(paths.config)) throw new Error(`No configuration at ${paths.config}. ${mac ? 'Run init.' : 'Install on the Mac first.'}`);
    return validateConfig(JSON.parse(readFileSync(paths.config, 'utf8')));
  };
  switch (command) {
    case 'init': {
      only(true, command);
      const { values } = parseArgs({ args: rest, options: { host: { type: 'string' }, mac: { type: 'string' } } });
      if (existsSync(paths.config)) throw new Error(`${paths.config} exists; edit it instead.`);
      privateWrite(paths.config, `${JSON.stringify(defaultConfig(values.host ?? '', values.mac), null, 2)}\n`);
      return console.log(`Saved ${paths.config}. Review it, then run install.`);
    }
    case 'install': only(true, command); return console.log(JSON.stringify(await install(readConfig()), null, 2));
    case 'start': only(true, command); return start();
    case 'stop': only(true, command); return void await stop();
    case 'restart': only(true, command); await stop(); return start();
    case 'uninstall': only(true, command); return uninstall();
    case 'logs':
      only(true, command);
      for (const log of ['tunnel.log', 'browser.log']) {
        const file = `${paths.directory}/${log}`;
        if (existsSync(file)) console.log(`== ${log}\n${readFileSync(file, 'utf8').trimEnd().split('\n').slice(-30).join('\n')}`);
      }
      return;
    case 'status': {
      const report = status(readConfig());
      if (rest.includes('--json')) console.log(JSON.stringify(report, null, 2));
      else console.log([`${report.side} → ${report.host}`, ...Object.entries({ ...report.agents, ...report.services }).filter(([, state]) => state)
        .map(([name, state]) => `  ${name}: ${state}`), report.error && `  error: ${report.error}`].filter(Boolean).join('\n'));
      const bad = Object.values(report.services).some(state => !['ready', 'available'].includes(state))
        || Object.values(report.agents ?? {}).some(state => state && state !== 'running');
      if (bad) process.exitCode = 1;
      return;
    }
    case 'mac': {
      only(false, command);
      if (rest[0] === '--') rest.shift();
      const address = readConfig().services.macLogin?.address;
      if (!address) throw new Error('Enable macLogin and install remote-access on your Mac first.');
      // Pass the remote exit status through unchanged.
      process.exitCode = spawnSync('/usr/bin/ssh', ['-F', paths.sshConfig, address, ...rest.map(shellQuote)], { stdio: 'inherit' }).status ?? 1;
      return;
    }
    case 'open':
      only(false, command);
      if (rest[0] === '--') rest.shift();
      if (rest.length !== 1) throw new Error('Usage: remote-access open URL_OR_PATH');
      return openOnMac(rest[0]);
    case 'install-helpers': only(false, command); return console.log(JSON.stringify(installHelpers(), null, 2));
    case 'skills-sync': only(false, command); return skillsSync(rest);
    case 'gcloud-login': only(false, command); return gcloudLogin();
    default: console.log(help);
  }
}

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
