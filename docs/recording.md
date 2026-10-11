# Browser video evidence

Aside exposes recording through the browser REPL:

```js
const clip = taskPage.video();
await clip.start({ path: path.join(pwd, 'artifacts', 'verification.webm') });
// Perform and verify the requested UI actions on taskPage.
await clip.stop();
console.log(await clip.path());
```

Keep the page and recorder handles across calls. Stop before closing the tab,
and verify the completed file before presenting it as evidence. Recording
captures the tab without audio; actions shown in a clip do not replace assertions.
`start` also accepts `format` (`webm` or `mp4`), `size`, `framerate` and `quality`;
`saveAs` copies a finished clip. Files and paths belong to the Mac session.
Copy the exact returned file to WSL with the existing pinned SSH connection.

Aside invokes `ffmpeg` by name in its GUI daemon's environment. Having Homebrew's
FFmpeg in a terminal PATH is insufficient if Aside was launched without that
PATH. Ensure it is discoverable by the daemon before recording; the installed
recorder can terminate the daemon on a missing executable. Do not add a second
recorder to work around this dependency.

The retained `remote-access recording fetch` command is for old Helium recording
IDs only; Aside clips use the file paths returned by `page.video().path()`.
