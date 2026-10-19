import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { asideProxy } from '../src/helpers.mjs';
import { shellQuote } from '../src/config.mjs';

// Runs the proxy with ssh swapped for a stand-in that hands the remote command to a
// local shell, and the Mac's aside swapped for a program that echoes its arguments.
const run = args => {
  const echo = `${shellQuote(process.execPath)} -e ${shellQuote('console.log(JSON.stringify(process.argv.slice(1)))')}`;
  const proxy = asideProxy('/config', 'mac', 'test')
    .replace(shellQuote('/Users/test/.local/bin/aside'), echo.replaceAll('$', '$$$$'))
    .replace('exec /usr/bin/ssh', 'ssh() { for last do :; done; /bin/sh -c "$last"; }; ssh');
  return spawnSync('/bin/sh', ['-c', proxy, 'aside', ...args], { encoding: 'utf8' });
};

test('proxy preserves code, quotes, empty arguments, Unicode and trailing newlines without shell expansion', () => {
  const args = ['repl', '', "console.log('quoted')", "''", "'", '$(exit 71)', '`exit 72`', '"$HOME"', 'héllo\n\n'];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('proxy forwards no arguments as none', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});
