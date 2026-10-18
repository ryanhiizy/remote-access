import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { zramCommands } from '../src/helpers.mjs';
import { powershell, recoverScript, windowsSshArgs } from '../src/manager.mjs';

const base = { version: 1, host: 'laptop.ts.net', services: { app: { localPort: 8080, remotePort: 8080 } } };

test('windows defaults to the WSL host on port 2222 and stays optional', () => {
  assert.deepEqual(validateConfig({ ...base, windows: {} }).windows, { host: 'laptop.ts.net', port: 2222 });
  assert.deepEqual(validateConfig({ ...base, windows: { host: 'laptop-win', port: 2200 } }).windows, { host: 'laptop-win', port: 2200 });
  assert.equal('windows' in validateConfig(base), false);
  assert.deepEqual(defaultConfig('laptop.ts.net').windows, { host: 'laptop.ts.net', port: 2222 });
});

test('windows rejects port 22, which WSL sshd owns, and unsafe hosts', () => {
  assert.throws(() => validateConfig({ ...base, windows: { port: 22 } }), /not be 22/);
  for (const host of ['-oProxyCommand=x', 'a b', '']) assert.throws(() => validateConfig({ ...base, windows: { host } }));
});

test('recover runs an encoded PowerShell script against the Windows port', () => {
  const command = powershell(recoverScript);
  const encoded = command.split(' ').at(-1);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), recoverScript);
  assert.match(recoverScript, /Temp\\wsl-crashes/);
  assert.match(recoverScript, /Start-ScheduledTask -TaskName 'WSL keep-alive'/);
  const args = windowsSshArgs(validateConfig({ ...base, windows: {} }), command);
  assert.deepEqual(args.slice(-4), ['-p', '2222', 'laptop.ts.net', command]);
  assert.ok(args.includes('BatchMode=yes'));
});

test('zram unit and install commands', () => {
  const unit = readFileSync(new URL('../wsl/zram-swap.service', import.meta.url), 'utf8');
  for (const line of ['ExecStart=zramctl --size 16G --algorithm lzo-rle /dev/zram0', 'ExecStart=swapon --priority 100 /dev/zram0',
    'ExecStop=zramctl --reset /dev/zram0', 'WantedBy=multi-user.target']) assert.ok(unit.includes(line), line);
  assert.deepEqual(zramCommands("/home/o'neil/zram-swap.service"), [
    "install -m 0644 '/home/o'\\''neil/zram-swap.service' /etc/systemd/system/zram-swap.service",
    'systemctl daemon-reload', 'systemctl enable --now zram-swap.service']);
});
