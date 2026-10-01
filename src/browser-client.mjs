import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { Transform } from 'node:stream';

const token = readFileSync(new URL('./browser-token', import.meta.url), 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid shared browser token. Reinstall remote-access.');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Pass the local shared browser service port.');
  process.exit(1);
}
const socket = createConnection({ host: '127.0.0.1', port });
const startup = setTimeout(() => { console.error('Shared browser service unavailable.'); socket.destroy(); process.exitCode = 1; }, 10000);
socket.once('connect', () => {
  clearTimeout(startup);
  process.stdin.setEncoding('utf8');
  let buffer = '';
  let initialized = false;
  const authenticate = new Transform({
    transform(chunk, encoding, done) {
      if (initialized) { done(null, chunk); return; }
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { done(new Error('Initialize message too large.')); return; }
      const end = buffer.indexOf('\n');
      if (end === -1) { done(); return; }
      try {
        const request = JSON.parse(buffer.slice(0, end));
        if (request.method !== 'initialize') throw new Error('Expected MCP initialize.');
        request.remoteAccessToken = token;
        initialized = true;
        done(null, `${JSON.stringify(request)}\n${buffer.slice(end + 1)}`);
        buffer = '';
      } catch (error) { done(error); }
    },
  });
  authenticate.once('error', error => { console.error(error.message); socket.destroy(); process.exitCode = 1; });
  process.stdin.pipe(authenticate).pipe(socket);
  socket.pipe(process.stdout, { end: false });
});
socket.once('error', error => { console.error(error.message); process.exitCode = 1; });
socket.once('close', () => { clearTimeout(startup); process.stdin.destroy(); });
process.stdin.once('end', () => socket.end());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => { socket.destroy(); process.stdin.destroy(); });
}
