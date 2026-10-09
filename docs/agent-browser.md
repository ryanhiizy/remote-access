# Using Helium through Executor

Executor already provides lazy tool discovery, sequential composition and
result filtering. Use those facilities; a second batching API or a smaller
browser tool catalogue is unnecessary.

Discover the needed tool once. Return its `inputTypeScript` from
`tools.describe.tool`, plus description or output fields only when needed.
Keep that schema for the task rather than rediscovering it each call.

Session, page discovery and video results expose `data.structuredContent`.
Use those fields inside Executor to pass IDs directly between dependent calls.
Check `ok` before using any result, and stop the sequence on failure. For
example, after discovering these tools, open a page and inspect it in one
Executor execution:

```js
const started = await tools.helium_mac.org.default.start_browser_session({label: 'Task name'});
if (!started.ok) return started;
const {sessionId} = started.data.structuredContent;
const opened = await tools.helium_mac.org.default.new_page({sessionId, url: 'https://example.com'});
if (!opened.ok) return {sessionId, error: opened.error};
const page = opened.data.structuredContent.pages?.find(page => page.selected);
if (!page) return {sessionId, result: opened.data.content};
const snapshot = await tools.helium_mac.org.default.take_snapshot({sessionId, pageId: page.id});
return {sessionId, pageId: page.id, result: snapshot.ok ? snapshot.data.content : snapshot.error};
```

Reuse the session thereafter. Run dependent actions sequentially, even inside
one Executor execution; use `fill_form` for several fields. Return intermediate
results when they contain information needed to decide the next action.

Emit the representation needed by the task, not both structured metadata and
its equivalent text. Use text content for snapshots and diagnostics, and
`structuredContent` for session/page/video metadata. Forward screenshot image
blocks with `emit` rather than serializing their bytes as text. Nothing is
truncated; request full snapshots, diagnostics or screenshots whenever useful.

For [video evidence](recording.md), one owned tab needs no separate recording
page lookup. `stop_video_recording({sessionId})` stops the latest clip. Supply
`recordingId` when retrying a stop after starting another clip. Keep native
recording page IDs separate from upstream page IDs; do not guess mappings from
URLs or tab order, which are ambiguous when pages share a URL.
