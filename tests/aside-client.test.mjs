import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { asideCommand } from '../src/aside-client.mjs';
import { shellQuote } from '../src/config.mjs';

test('remote CLI preserves code, empty arguments, Unicode and trailing newlines without shell expansion', () => {
  const args = ['repl', '', "console.log('quoted')", '$(exit 71)', '`exit 72`', 'héllo\n\n'];
  const command = asideCommand('test', args).replace(shellQuote('/Users/test/.local/bin/aside'),
    `${shellQuote(process.execPath)} -e ${shellQuote('console.log(JSON.stringify(process.argv.slice(1)))')}`);
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('remote CLI rejects invalid usernames before constructing a command', () => {
  for (const user of [undefined, '', '../other', 'a;exit', 'a\nb']) assert.throws(() => asideCommand(user, []));
});
