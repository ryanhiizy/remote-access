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
