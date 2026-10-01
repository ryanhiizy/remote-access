import 'chrome-devtools-mcp/build/src/utils/polyfill.js';
import { BrowserManager } from 'chrome-devtools-mcp/build/src/BrowserManager.js';
import { McpServer } from 'chrome-devtools-mcp';
import { parseArguments } from 'chrome-devtools-mcp/build/src/config/mcp-options.js';
import { createServer } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readEndpoint } from './config.mjs';

const maxMessageBytes = 8 * 1024 * 1024;

// One MCP context per client preserves tab selection and request identifiers.
// Closing a client must not disconnect the shared Helium connection.
export class SocketTransport {
  constructor(socket, initial = '') { this.socket = socket; this.buffer = initial; }
  async start() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', data => { this.buffer += data; this.read(); });
    this.socket.on('error', error => this.onerror?.(error));
    this.socket.on('close', () => this.onclose?.());
    this.read();
    this.socket.resume();
  }
  read() {
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > maxMessageBytes) { this.socket.destroy(); return; }
      try { this.onmessage?.(JSON.parse(line)); }
      catch (error) { this.onerror?.(error); this.socket.destroy(); return; }
    }
    if (Buffer.byteLength(this.buffer) > maxMessageBytes) this.socket.destroy();
  }
  send(message) {
    return new Promise((resolve, reject) => {
      this.socket.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
    });
  }
  async close() { this.socket.destroy(); }
}

export function sharedBrowserManager(manager, endpoint) {
  let browser;
  let pending = 0;
  let connectionId = null;
  let connections = 0;
  return {
    async ensureBrowser() {
      pending++;
      try {
        const current = await manager.ensureBrowser();
        if (current !== browser) { browser = current; connectionId = randomUUID(); connections++; }
        return current;
      } finally { pending--; }
    },
    // McpServer.close() invokes this on every client disconnect.
    async close() {},
    status() {
      return {
        state: browser?.connected ? 'ready' : pending ? 'waiting-for-approval' : endpoint() ? 'available' : 'unavailable',
        connectionId, connections,
      };
    },
  };
}

export function sharedBrowserService(profile, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Shared browser token missing. Run remote-access install.');
  const args = parseArguments('1.10.1', ['node', 'shared-browser', '--autoConnect',
    `--user-data-dir=${profile}`, '--no-usage-statistics', '--no-performance-crux']);
  const manager = new BrowserManager(args, {});
  const shared = sharedBrowserManager(manager, () => readEndpoint(profile));
  const sessions = new Set();
  const sockets = new Set();
  let stopping = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    const timeout = setTimeout(() => socket.destroy(), 10000);
    let initial = '';
    const first = async data => {
      initial += data;
      if (Buffer.byteLength(initial) > maxMessageBytes) { socket.destroy(); return; }
      const end = initial.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timeout);
      socket.removeListener('data', first);
      socket.pause();
      try {
        const request = JSON.parse(initial.slice(0, end));
        if (request.method === 'remote-access/status') {
          socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ...shared.status(), clients: sessions.size } })}\n`);
          return;
        }
        if (request.method !== 'initialize' || stopping) { socket.destroy(); return; }
        const supplied = Buffer.from(typeof request.remoteAccessToken === 'string' ? request.remoteAccessToken : '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Shared browser client is not authorized.' } })}\n`);
          return;
        }
        // The secret authenticates this transport, not the MCP/browser protocol.
        delete request.remoteAccessToken;
        initial = `${JSON.stringify(request)}\n${initial.slice(end + 1)}`;
        const mcp = await McpServer.from(args, { browserManager: shared });
        if (socket.destroyed || stopping) { await mcp.close(); return; }
        sessions.add(mcp);
        socket.once('close', () => {
          sessions.delete(mcp);
          void mcp.close().catch(error => console.error(error.message));
        });
        await mcp.connect(new SocketTransport(socket, initial));
      } catch (error) { console.error(error.message); socket.destroy(); }
    };
    socket.on('data', first);
    socket.once('close', () => clearTimeout(timeout));
  });
  return {
    server,
    async close() {
      stopping = true;
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...sessions].map(mcp => mcp.close()));
      await manager.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
