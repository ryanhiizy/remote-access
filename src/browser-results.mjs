import { snapshotOptions, snapshotOutput, snapshotArguments, snapshotResult, replaceSnapshot } from './browser-snapshots.mjs';

// MCP text remains usable in ordinary clients; Executor can select typed fields
// from structuredContent without parsing the JSON inside a text block.
export const jsonResult = value => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
});

export const sessionOutput = {
  type: 'object', properties: { sessionId: { type: 'string' }, label: { type: 'string' } },
  required: ['sessionId', 'label'], additionalProperties: false,
};
export const endSessionOutput = {
  type: 'object', properties: { ended: { type: 'boolean' } },
  required: ['ended'], additionalProperties: false,
};
export const recordingOutput = {
  type: 'object',
  properties: {
    recordingId: { type: 'string' },
    state: { type: 'string', enum: ['recording', 'stopping', 'saved', 'failed'] },
    macPath: { type: 'string' }, durationSeconds: { type: 'number' }, bytes: { type: 'integer' },
    reason: { type: 'string' }, error: { type: 'string' },
  },
  required: ['recordingId', 'state', 'macPath', 'durationSeconds'], additionalProperties: false,
};
export const recordingListOutput = {
  type: 'object',
  properties: {
    pages: { type: 'array', items: {
      type: 'object', properties: { recordingPageId: { type: 'string' }, url: { type: 'string' } },
      required: ['recordingPageId', 'url'], additionalProperties: false,
    } },
    recordings: { type: 'array', items: recordingOutput },
  },
  required: ['pages', 'recordings'], additionalProperties: false,
};

// Upstream page discovery exposes stable IDs here. Keep other fields open so
// navigation warnings, dialogs and future upstream metadata remain available.
export const pageOutput = {
  type: 'object', properties: {
    pages: { type: 'array', items: {
      type: 'object', properties: {
        id: { type: 'number' }, url: { type: 'string' }, title: { type: 'string' },
        selected: { type: 'boolean' }, isolatedContext: { type: 'string' },
      }, required: ['id', 'url', 'title', 'selected'], additionalProperties: true,
    } },
  }, additionalProperties: true,
};
export const pageResultTools = new Set(['new_page', 'list_pages', 'select_page', 'close_page', 'navigate_page']);

const scriptOutput = {
  type: 'object', properties: {
    resultType: { type: 'string', enum: ['json', 'undefined'] },
    value: {},
  }, additionalProperties: true,
};

// Extend only the catalogue and response boundary. Upstream still owns browser
// actions, waits, snapshot generation/UIDs, file writes and error handling.
export function browserTool(tool) {
  if (pageResultTools.has(tool.name)) return { ...tool, outputSchema: pageOutput };
  if (tool.name === 'evaluate_script') return {
    ...tool, outputSchema: scriptOutput,
    description: `${tool.description} Inline results also expose structuredContent.value (resultType distinguishes undefined); no text parsing needed.`,
  };
  if (tool.name === 'take_screenshot') return {
    ...tool, description: `${tool.description} For inline inspection, omit filePath and emit the returned image blocks.`,
  };
  const extra = tool.name === 'take_snapshot' ? snapshotOptions : tool.name === 'wait_for' ? {
    includeSnapshot: { type: 'boolean', default: true, description: 'Set false for confirmation only, without the page snapshot. Default true preserves the full response.' },
  } : null;
  return extra ? {
    ...tool,
    ...(tool.name === 'take_snapshot' ? { outputSchema: snapshotOutput } : {}),
    ...(tool.name === 'wait_for' ? { description: `${tool.description} Use expected UI text, not a dummy target for sleeping.` } : {}),
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, ...extra } },
  } : tool;
}

export function browserArguments(name, params) {
  if (name === 'take_snapshot') {
    return snapshotArguments(params);
  }
  if (name === 'wait_for') {
    const { includeSnapshot, ...upstream } = params;
    if (includeSnapshot !== undefined && typeof includeSnapshot !== 'boolean') throw new Error('includeSnapshot must be a boolean.');
    return upstream;
  }
  return params;
}

export function browserResult(name, params, result) {
  const { structuredContent, ...contentResult } = result;
  if (pageResultTools.has(name)) return result;
  if (result.isError || structuredContent?.errorMessage) {
    return ['evaluate_script', 'take_snapshot'].includes(name) ? result : contentResult;
  }
  if (name === 'evaluate_script') {
    const data = { ...structuredContent };
    const prefix = 'Script ran on page and returned:\n```json\n';
    const message = data.message;
    if (!params.filePath && typeof message === 'string' && message.startsWith(prefix) && message.endsWith('\n```')) {
      const json = message.slice(prefix.length, -4);
      // Keep the original text for legacy MCP clients. Parsing happens once in
      // the bridge; Executor callers can select value without wrapper code.
      if (json === 'undefined') data.resultType = 'undefined';
      else {
        try { data.value = JSON.parse(json); data.resultType = 'json'; }
        catch { return { ...contentResult, structuredContent: data }; }
      }
      delete data.message;
    }
    return { ...contentResult, structuredContent: data };
  }
  if (name === 'wait_for' && params.includeSnapshot === false && structuredContent?.snapshot) {
    return { ...contentResult, content: replaceSnapshot(result, '') };
  }
  if (name === 'take_snapshot') return snapshotResult(params, result);
  return contentResult;
}
