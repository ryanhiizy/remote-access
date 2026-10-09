# Browser video evidence

Use Executor `helium_mac` with the chat's browser session. Open the tab to record
with `new_page`, then call `start_video_recording`. If the session has several
tabs, call `list_video_recordings` and pass its `recordingPageId`; these IDs are
separate from DevTools numeric page IDs. Recording stays on that tab when the
selected tab changes. It captures the viewport, without audio or desktop UI.

Call `stop_video_recording` before fetching the file. Omit `recordingId` to stop
this session's latest recording; retain and supply the ID when retrying a stop
after starting another recording. Session and video tools expose typed metadata
in `structuredContent`, so Executor can use the ID without parsing text. The default duration limit is 120 seconds (maximum
300); ending the session also finalizes the clip. Stop before closing its tab;
closing the tab or browser can interrupt capture and leave a failed recording. The tools
return Mac paths; recordings remain on disk after the session ends. Remove
unneeded files from `~/Library/Application Support/remote-access/recordings`.
Only finalized files have a `.webm` extension; `.partial` files are incomplete.
A service crash can leave a partial file that must not be used as evidence.

On the remote machine:

```sh
remote-access recording fetch RECORDING_ID ./demo.webm
gh pr comment PR_URL --body 'Browser verification' --attach ./demo.webm
```

Fetching uses the existing pinned SSH connection and refuses to overwrite a
local file. Upload only after inspecting the clip for relevant content. A video
shows the recorded actions; report separately which assertions were verified.

Requires Helium based on Chromium 153+ for native recording. After updating the source,
run `remote-access install` there and refresh Executor's `helium_mac` tool
catalogue on each Executor host. The Linux CLI must also use the updated source.
GitHub CLI must support `gh pr comment --attach` for direct uploads.
