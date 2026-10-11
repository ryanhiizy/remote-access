# Browser video evidence

Use Chromium's built-in WebM recorder through Executor `aside_mac.repl`.
It needs Chromium 153+ and Aside's `_sendToTarget` method; report a blocker if
either is unavailable. Aside's `page.video()` uses a different FFmpeg recorder
that can lose frames or hang on stop. No FFmpeg or launch PATH change is needed
for the browser encoder.

```js
const clip = await taskPage._sendToTarget('Page.startScreenRecording', {
  audio: false, maxWidth: 1920, maxHeight: 1080, frameRate: 15,
});
// Perform and verify UI actions; keep taskPage and clip across REPL calls.
await taskPage._sendToTarget('Page.stopScreenRecording');
const chunks = [];
while (true) {
  const chunk = await taskPage._sendToTarget('IO.read', { handle: clip.stream, size: 1048576 });
  if (chunk.data) chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
  if (chunk.eof) break;
}
const file = path.join(pwd, 'artifacts', `verification-${Date.now()}.webm`);
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, Buffer.concat(chunks));
await taskPage._sendToTarget('IO.close', { handle: clip.stream });
console.log({ file, bytes: (await fs.stat(file)).size });
```

Stop before closing the tab, including when the tested flow fails. Verify that
the saved video shows the expected visual transitions; file existence alone
is insufficient. Files belong to the Mac session: copy the returned path over
the pinned SSH connection for WSL uploads. `remote-access recording fetch`
accepts legacy Helium IDs, not Aside paths. Never print video chunks to the model.
