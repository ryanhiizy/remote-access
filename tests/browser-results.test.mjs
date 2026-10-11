import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserArguments, browserResult, browserTool } from '../src/browser-results.mjs';

const text = value => ({ type: 'text', text: value });
const evaluate = value => ({
  content: [text(`Script ran on page and returned:\n\`\`\`json\n${value}\n\`\`\``)],
  structuredContent: { message: `Script ran on page and returned:\n\`\`\`json\n${value}\n\`\`\``, dialog: { type: 'alert' } },
});
const snapshot = {
  content: [text('Note: browser reconnected.\n## Latest page snapshot\nfull page and unrelated content\n'), { type: 'image', data: 'untouched', mimeType: 'image/png' }],
  structuredContent: {
    reconnected: true,
    snapshot: { id: '1_0', role: 'RootWebArea', children: [
      { id: '1_1', role: 'navigation', name: 'Unrelated' },
      { id: '1_2', role: 'dialog', name: 'Details', children: [
        { id: '1_3', role: 'button', name: 'Close\n## Latest page snapshot', disabled: true, value: 'value' },
      ] },
    ] },
  },
};

test('inline script values preserve types and legacy text, including fences in strings', () => {
  for (const value of [null, false, 0, '', 'undefined', '```json\nvalue\n```', [1, null], { nested: { x: 'a\nb' } }]) {
    const input = evaluate(JSON.stringify(value));
    const result = browserResult('evaluate_script', {}, input);
    assert.deepEqual(result.content, input.content);
    assert.deepEqual(result.structuredContent, { dialog: { type: 'alert' }, value, resultType: 'json' });
    assert.ok(input.structuredContent.message, 'does not mutate upstream response');
  }
  const result = browserResult('evaluate_script', {}, evaluate('undefined'));
  assert.equal(result.structuredContent.resultType, 'undefined');
  assert.equal(Object.hasOwn(result.structuredContent, 'value'), false);
});

test('file output, unexpected formatting and script errors are never interpreted as values', () => {
  const saved = { content: [text('Output saved to /tmp/result.json.')], structuredContent: { message: 'Output saved to /tmp/result.json.' } };
  assert.deepEqual(browserResult('evaluate_script', { filePath: '/tmp/result.json' }, saved), saved);
  for (const input of [evaluate('not JSON'), { content: [text('changed format')], structuredContent: { message: 'changed format' } }]) {
    assert.deepEqual(browserResult('evaluate_script', {}, input), input);
  }
  const error = { ...evaluate('42'), isError: true };
  assert.equal(browserResult('evaluate_script', {}, error), error);
  const diagnostic = { ...saved, structuredContent: { errorMessage: 'Execution failed' } };
  assert.equal(browserResult('evaluate_script', {}, diagnostic), diagnostic);
});

test('full snapshots and default waits preserve original content byte-for-byte', () => {
  for (const [name, params] of [['take_snapshot', {}], ['wait_for', {}], ['wait_for', { includeSnapshot: true }]]) {
    assert.deepEqual(browserResult(name, params, snapshot).content, snapshot.content);
  }
});

test('confirmation-only waits preserve diagnostics and image blocks', () => {
  const result = browserResult('wait_for', { includeSnapshot: false }, snapshot);
  assert.equal(result.content[0].text, 'Note: browser reconnected.');
  assert.deepEqual(result.content[1], snapshot.content[1]);
  for (const extra of [{ isError: true }, { structuredContent: { ...snapshot.structuredContent, errorMessage: 'Failure after snapshot' } }]) {
    const error = { ...snapshot, ...extra };
    assert.deepEqual(browserResult('wait_for', { includeSnapshot: false }, error).content, snapshot.content);
  }
});

test('scopes contain all descendant attributes and actionable UIDs, without siblings', () => {
  const result = browserResult('take_snapshot', { scopeUid: '1_2' }, snapshot);
  const output = result.content[0].text;
  assert.match(output, /Note: browser reconnected/);
  assert.match(output, /uid=1_2 dialog name="Details"/);
  assert.match(output, /uid=1_3 button/);
  assert.match(output, /disabled=true value="value"/);
  assert.ok(output.includes('name="Close\\n## Latest page snapshot"'));
  assert.doesNotMatch(output, /Unrelated|full page and unrelated content/);
  assert.deepEqual(result.content[1], snapshot.content[1]);
});

test('missing scopes return an explicit error and the fresh full snapshot for recovery', () => {
  const result = browserResult('take_snapshot', { scopeUid: 'stale' }, snapshot);
  assert.equal(result.isError, true);
  assert.deepEqual(result.content.slice(1), snapshot.content);
});

test('adapter validates only added options and forwards upstream arguments unchanged', () => {
  assert.deepEqual(browserArguments('take_snapshot', { pageId: 1, verbose: true, scopeUid: '1_2' }), { pageId: 1, verbose: true });
  assert.deepEqual(browserArguments('wait_for', { text: ['Ready'], timeout: 123, includeSnapshot: false }), { text: ['Ready'], timeout: 123 });
  for (const scopeUid of ['', ' ', 5, null]) assert.throws(() => browserArguments('take_snapshot', { scopeUid }));
  assert.throws(() => browserArguments('take_snapshot', { scopeUid: '1_2', filePath: '/tmp/snapshot.txt' }));
  assert.throws(() => browserArguments('wait_for', { includeSnapshot: 'false' }));
  const screenshot = { pageId: 1, fullPage: true, format: 'webp', quality: 90, filePath: '/tmp/image.webp' };
  assert.equal(browserArguments('take_screenshot', screenshot), screenshot);
});

test('catalogue retains existing schema and every unrelated tool/result', () => {
  const tool = { name: 'take_snapshot', description: 'Original', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } }, required: ['pageId'] } };
  const extended = browserTool(tool);
  assert.deepEqual(extended.inputSchema.required, tool.inputSchema.required);
  assert.deepEqual(extended.inputSchema.properties.verbose, tool.inputSchema.properties.verbose);
  assert.ok(extended.inputSchema.properties.scopeUid);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, 'scopeUid'), false);
  const other = { ...tool, name: 'performance_start_trace' };
  assert.equal(browserTool(other), other);
  assert.deepEqual(browserResult(other.name, {}, snapshot), { content: snapshot.content });
  assert.equal(browserResult('list_pages', {}, snapshot), snapshot);
});
