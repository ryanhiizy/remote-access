// Shares one approved Helium DevTools connection with every MCP client.
// Run by launchd: node browser-service.mjs PORT PROFILE TOKEN_FILE
import 'chrome-devtools-mcp/build/src/utils/polyfill.js';
import { BrowserManager } from 'chrome-devtools-mcp/build/src/BrowserManager.js';
import { parseArguments } from 'chrome-devtools-mcp/build/src/config/mcp-options.js';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEndpoint } from './config.mjs';
import { BrowserSessions, sessionMcpServer } from './browser-sessions.mjs';

const maxMessageBytes = 8 * 1024 * 1024;

// Socket lifetime does not own browser sessions. Executor can multiplex chats
// on one socket and replace that socket between successive tool calls.
export class SocketTransport {
  constructor(socket, initial = '') { this.socket = socket; this.buffer = initial; }
  async start() {
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
      try { this.onmessage?.(JSON.parse(line)); }
      catch (error) { this.onerror?.(error); this.socket.destroy(); return; }
    }
    if (Buffer.byteLength(this.buffer) > maxMessageBytes) this.socket.destroy();
  }
  send(message) {
    return new Promise((resolve, reject) => this.socket.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve()));
  }
  async close() { this.socket.destroy(); }
}

export function sharedBrowserManager(manager, endpoint) {
  let browser;
  let pending = 0;
  let connectionId = null;
  return {
    async ensureBrowser() {
      pending++;
      try {
        const current = await manager.ensureBrowser();
        if (current !== browser) { browser = current; connectionId = randomUUID(); }
        return current;
      } finally { pending--; }
    },
    // McpServer.close() invokes this on every client disconnect.
    async close() {},
    status() {
      return { state: browser?.connected ? 'ready' : pending ? 'waiting-for-approval' : endpoint() ? 'available' : 'unavailable', connectionId };
    },
  };
}

export function sharedBrowserService(profile, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Shared browser token missing. Run remote-access install.');
  const args = parseArguments('1.10.1', ['node', 'shared-browser', '--autoConnect',
    `--user-data-dir=${profile}`, '--no-usage-statistics', '--no-performance-crux', '--allow-unrestricted-paths']);
  const manager = new BrowserManager(args, {});
  const shared = sharedBrowserManager(manager, () => readEndpoint(profile));
  const browserSessions = new BrowserSessions(shared, args);
  const sessions = new Set();
  const expected = Buffer.from(token);
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
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
      // Passive status for curl; never touches the browser connection.
      if (initial.startsWith('GET /status ')) {
        const body = JSON.stringify({ ...shared.status(), clients: sessions.size });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      try {
        const request = JSON.parse(initial.slice(0, end));
        const supplied = Buffer.from(typeof request.remoteAccessToken === 'string' ? request.remoteAccessToken : '');
        if (request.method !== 'initialize' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32001, message: 'Shared browser client is not authorized.' } })}\n`);
          return;
        }
        // The token authenticates this transport, not the MCP/browser protocol.
        delete request.remoteAccessToken;
        initial = `${JSON.stringify(request)}\n${initial.slice(end + 1)}`;
        const mcp = await sessionMcpServer(args, browserSessions);
        if (socket.destroyed) { await mcp.close(); return; }
        sessions.add(mcp);
        socket.once('close', () => { sessions.delete(mcp); void mcp.close().catch(error => console.error(error.message)); });
        await mcp.connect(new SocketTransport(socket, initial));
      } catch (error) { console.error(error.message); socket.destroy(); }
    };
    socket.on('data', first);
  });
  return { server, close: async () => { await browserSessions.close(); await manager.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port, profile, tokenFile] = process.argv.slice(2);
  const service = sharedBrowserService(profile, readFileSync(tokenFile, 'utf8').trim());
  service.server.listen(Number(port), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => service.close().finally(() => process.exit(0)));
}
