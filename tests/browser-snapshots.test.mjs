import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotArguments } from '../src/browser-snapshots.mjs';
import { browserResult } from '../src/browser-results.mjs';

function capture(name = 'Save', id = '1_0', url = 'https://example.test') {
  return {
    content: [{ type: 'text', text: `Warning stays visible.\n## Latest page snapshot\nuid=${id} RootWebArea\n  uid=1_1 button "${name}"\n` }],
    structuredContent: { snapshot: { id, name: 'Test page', role: 'RootWebArea', url, children: [
      { id: '1_1', role: 'button', name, disabled: true, children: [{ id: '1_2', role: 'StaticText', name }] },
      { id: '1_3', role: 'button', name: 'Cancel' },
    ] } },
  };
}
const render = (params, result) => browserResult('take_snapshot', { pageId: 1, ...params }, result);

test('role/name lookup works on the first capture and preserves actionable descendants', () => {
  const result = render({ match: { role: 'button', name: 'Save' } }, capture());
  assert.deepEqual(result.structuredContent.matches, [{ uid: '1_1', role: 'button', name: 'Save' }]);
  assert.match(result.content[0].text, /uid=1_2 StaticText/);
  assert.match(result.content[0].text, /disabled=true/);
  assert.doesNotMatch(result.content[0].text, /Cancel/);
});

test('duplicate and nested matches retain every match ID without duplicate subtree text', () => {
  const result = render({ match: { name: 'Save' } }, capture());
  assert.deepEqual(result.structuredContent.matches.map(n => n.uid), ['1_1', '1_2']);
  assert.equal(result.content[0].text.match(/uid=1_2/g).length, 1);
  assert.equal(render({ match: { role: 'button' } }, capture()).structuredContent.matches.length, 2);
  assert.deepEqual(render({ match: { name: 'save' } }, capture()).structuredContent.matches, []);
  assert.deepEqual(render({ scopeUid: '1_1', match: { name: 'Cancel' } }, capture()).structuredContent.matches, []);
});

test('each lookup uses the supplied fresh tree, including changed attributes and removals', () => {
  const params = { match: { role: 'button' } };
  assert.equal(render(params, capture()).structuredContent.matches.length, 2);
  const next = capture('Updated');
  next.structuredContent.snapshot.children[0].disabled = false;
  next.structuredContent.snapshot.children.pop();
  const result = render(params, next);
  assert.deepEqual(result.structuredContent.matches, [{ uid: '1_1', role: 'button', name: 'Updated' }]);
  assert.match(result.content[0].text, /disabled=false/);
  assert.doesNotMatch(result.content[0].text, /Cancel/);
});

test('lookup preserves diagnostics and images; errors return the complete upstream result', () => {
  const input = capture();
  input.content.push({ type: 'image', data: 'keep', mimeType: 'image/png' });
  const result = render({ match: { name: 'Save' } }, input);
  assert.match(result.content[0].text, /Warning stays visible/);
  assert.deepEqual(result.content[1], input.content[1]);
  for (const extra of [{ isError: true }, { structuredContent: { errorMessage: 'Disconnected' } }]) {
    const error = { ...input, ...extra };
    assert.equal(render({ match: { name: 'Save' } }, error), error);
  }
  assert.throws(() => render({ match: { role: 'button' } }, { content: [] }), /No accessibility snapshot/);
});

test('invalid options and file-output combinations fail before upstream side effects', () => {
  for (const match of [{}, null, [], 'button', { role: '' }, { name: 3 }, { typo: 'button' }]) assert.throws(() => snapshotArguments({ match }));
  for (const opts of [{ match: { role: 'button' } }, { scopeUid: '1_1' }]) {
    assert.throws(() => snapshotArguments({ ...opts, filePath: '/tmp/result.txt' }));
  }
  assert.deepEqual(snapshotArguments({ pageId: 1, filePath: '/tmp/result.txt' }), { pageId: 1, filePath: '/tmp/result.txt' });
});
