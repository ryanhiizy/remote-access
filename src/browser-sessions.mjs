import 'chrome-devtools-mcp/build/src/utils/polyfill.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer as ChromeMcpServer } from 'chrome-devtools-mcp';
import { Client, McpServer, Mutex } from 'chrome-devtools-mcp/build/src/third_party/index.js';

import { BrowserRecordings, recordingTools } from './browser-recordings.mjs';

const downloadContexts = new WeakMap();
function enableDownloads(context) {
  if (!downloadContexts.has(context)) {
    const downloadPath = join(homedir(), 'Downloads');
    const ready = mkdir(downloadPath, { recursive: true })
      .then(() => context.setDownloadBehavior({ policy: 'allow', downloadPath }))
      .catch(error => { downloadContexts.delete(context); throw error; });
    downloadContexts.set(context, ready);
  }
  return downloadContexts.get(context);
}

// The browser/profile is shared; discovery and MCP state are not. In particular,
// an Executor connection is not a chat: several chats can use the same socket.
export function ownedBrowser(browser) {
  const owned = new WeakSet();
  const contexts = new Set();
  const listeners = new Map();
  const owns = target => {
    if (owned.has(target)) return true;
    if (contexts.has(target.browserContext())) { owned.add(target); return true; }
    const opener = target.opener();
    if (opener && owns(opener)) { owned.add(target); return true; }
    return false;
  };
  const claim = page => { owned.add(page.target()); return page; };
  const bound = (object, key) => {
    const value = Reflect.get(object, key, object);
    return typeof value === 'function' ? value.bind(object) : value;
  };
  const overrides = {
    pages: async (...args) => (await browser.pages(...args)).filter(page => owns(page.target())),
    targets: () => browser.targets().filter(owns),
    newPage: async (...args) => claim(await browser.newPage(...args)),
    browserContexts: () => [browser.defaultBrowserContext(), ...contexts],
    createBrowserContext: async (...args) => {
      const context = await browser.createBrowserContext(...args);
      try { await enableDownloads(context); }
      catch (error) { await context.close(); throw error; }
      contexts.add(context);
      return context;
    },
    on(event, listener) {
      let byListener = listeners.get(event);
      if (!byListener) { byListener = new Map(); listeners.set(event, byListener); }
      const filtered = target => { if (owns(target)) listener(target); };
      byListener.set(listener, filtered);
      browser.on(event, filtered);
      return facade;
    },
    off(event, listener) {
      const filtered = listeners.get(event)?.get(listener);
      if (filtered) browser.off(event, filtered);
      listeners.get(event)?.delete(listener);
      return facade;
    },
  };
  const facade = new Proxy(browser, { get(object, key) {
    return Object.hasOwn(overrides, key) ? overrides[key] : bound(object, key);
  } });
  return facade;
}

// Each named session gets an unchanged Chrome DevTools MCP server. These local
// transports only connect it to the router; upstream owns schemas, handlers,
// snapshots, filesystem policy and tool serialization.
async function connectChrome(args, manager) {
  const server = await ChromeMcpServer.from(args, { browserManager: manager });
  const pair = [{}, {}];
  for (const [index, transport] of pair.entries()) {
    transport.start = async () => {};
    transport.send = async message => { queueMicrotask(() => pair[1 - index].onmessage?.(structuredClone(message))); };
    transport.close = async () => { transport.onclose?.(); };
  }
  const client = new Client({ name: 'helium-session-router', version: '1' });
  try {
    await server.connect(pair[0]);
    await client.connect(pair[1]);
    return { client, close: async () => { await client.close(); await server.close(); } };
  } catch (error) { await server.close(); throw error; }
}

export class BrowserSessions {
  constructor(manager, args) {
    this.manager = manager;
    this.args = args;
    this.sessions = new Map();
  }
  async start(label) {
    if (this.sessions.size >= 128) throw new Error('Browser session limit reached. End an unused session first.');
    const session = { id: randomUUID(), label, mutex: new Mutex(), recordings: new BrowserRecordings() };
    this.sessions.set(session.id, session);
    try {
      session.connection = await connectChrome(this.args, {
        ensureBrowser: async () => {
          const browser = await this.manager.ensureBrowser();
          if (session.browser && session.browser !== browser) {
            throw new Error('Helium reconnected. End this session and start a new one; old page and snapshot ids are no longer valid.');
          }
          await enableDownloads(browser.defaultBrowserContext());
          session.browser = browser;
          session.owned ??= ownedBrowser(browser);
          return session.owned;
        },
        close: async () => {}, // Ending a session must not disconnect Helium.
      });
      return session;
    } catch (error) { this.sessions.delete(session.id); throw error; }
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown browser session. Call start_browser_session once for this chat, then reuse its sessionId.');
    return session;
  }
  async call(id, name, params) {
    const session = this.get(id);
    const guard = await session.mutex.acquire();
    try {
      this.get(id); // An end queued before this call invalidates it.
      if (recordingTools.some(tool => tool.name === name)) {
        if (session.browser && session.browser !== await this.manager.ensureBrowser()) throw new Error('Helium reconnected. Start a new browser session.');
        return await session.recordings.call(name, params, session.owned);
      }
      return await session.connection.client.callTool({ name, arguments: params });
    } finally { guard[Symbol.dispose](); }
  }
  async end(id) {
    const session = this.get(id);
    const guard = await session.mutex.acquire();
    try { await session.recordings.close(); await session.connection.close(); this.sessions.delete(id); }
    finally { guard[Symbol.dispose](); }
  }
  async close() { await Promise.all([...this.sessions.keys()].map(id => this.end(id))); }
}

const sessionIdSchema = { type: 'string', format: 'uuid', description: 'This chat’s start_browser_session ID; reuse across calls and reconnects.' };
const textResult = text => ({ content: [{ type: 'text', text }] });
const sessionTools = [
  {
    name: 'start_browser_session',
    description: 'Call once per chat; retain sessionId. Use new_page to open owned tabs. Normal tabs share sign-in; other sessions’ tabs are excluded.',
    inputSchema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['label'], additionalProperties: false },
  },
  {
    name: 'end_browser_session',
    description: 'Release this session and invalidate its IDs. Leaves tabs open and other sessions running.',
    inputSchema: { type: 'object', properties: { sessionId: sessionIdSchema }, required: ['sessionId'], additionalProperties: false },
  },
];

export async function sessionMcpServer(args, sessions) {
  // Forward upstream tools unchanged, adding the session envelope and our
  // recording tools. Each recording shares the owning session’s lifetime.
  // One catalogue per shared service, including simultaneous client connections.
  const tools = await (sessions.catalogue ??= (async () => {
    const catalogue = await connectChrome(args, { ensureBrowser: async () => { throw new Error('Catalogue connection cannot access Helium.'); }, close: async () => {} });
    try {
      const { tools } = await catalogue.client.listTools();
      return [...sessionTools, ...[...recordingTools, ...tools].map(tool => ({ ...tool,
        inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, sessionId: sessionIdSchema }, required: [...(tool.inputSchema.required ?? []), 'sessionId'] },
      }))];
    } finally { await catalogue.close(); }
  })().catch(error => { sessions.catalogue = undefined; throw error; }));
  const server = new McpServer({ name: 'helium-session-router', version: '1.0.0' }, { capabilities: { tools: {}, logging: {} } });
  server.server.setRequestHandler('logging/setLevel', () => ({}));
  server.server.setRequestHandler('tools/list', () => ({ tools }));
  server.server.setRequestHandler('tools/call', async request => {
    try {
      const { name, arguments: parameters = {} } = request.params;
      if (name === 'start_browser_session') {
        const label = parameters.label?.trim();
        if (!label || label.length > 80 || Object.keys(parameters).some(key => key !== 'label')) throw new Error('Supply a task label of 1–80 characters.');
        const session = await sessions.start(label);
        return textResult(JSON.stringify({ sessionId: session.id, label }));
      }
      const { sessionId, ...params } = parameters;
      if (name === 'end_browser_session') {
        if (Object.keys(params).length) throw new Error('Only sessionId is accepted.');
        await sessions.end(sessionId);
        return textResult('Browser session ended. Tabs left open for the user.');
      }
      return await sessions.call(sessionId, name, params);
    } catch (error) { return { ...textResult(error.message), isError: true }; }
  });
  return server;
}
