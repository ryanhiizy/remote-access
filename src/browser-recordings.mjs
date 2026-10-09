import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { locations } from './config.mjs';

const directory = () => join(locations(homedir(), 'darwin').directory, 'recordings');
const ffmpegPath = () => ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg';
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errorText = error => error instanceof Error ? error.message : String(error);

// Recording IDs and page IDs are scoped to the owning chat, independent of MCP
// socket lifetime. We never infer upstream numeric page IDs from array order.
export class BrowserRecordings {
  constructor({ outputDirectory = directory() } = {}) {
    this.directory = outputDirectory;
    this.pages = new Map();
    this.recordings = new Map();
  }
  async availablePages(browser) {
    const pages = browser ? await browser.pages() : [];
    for (const [id, page] of this.pages) if (!pages.includes(page)) this.pages.delete(id);
    for (const page of pages) {
      if (![...this.pages.values()].includes(page)) this.pages.set(randomUUID(), page);
    }
    return [...this.pages].map(([recordingPageId, page]) => ({ recordingPageId, url: page.url() }));
  }
  describe(recording) {
    return { recordingId: recording.id, state: recording.state, macPath: recording.path,
      durationSeconds: Math.round(((recording.ended ?? Date.now()) - recording.started) / 100) / 10,
      ...(recording.bytes !== undefined ? { bytes: recording.bytes } : {}),
      ...(recording.reason ? { reason: recording.reason } : {}),
      ...(recording.error ? { error: recording.error } : {}) };
  }
  async call(name, params, browser) {
    const allowed = name === 'start_video_recording' ? ['recordingPageId', 'maxSeconds']
      : name === 'stop_video_recording' ? ['recordingId'] : [];
    if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error(`Accepted arguments: ${allowed.join(', ') || 'sessionId only'}.`);
    if (name === 'list_video_recordings') {
      return result({ pages: await this.availablePages(browser), recordings: [...this.recordings.values()].map(recording => this.describe(recording)) });
    }
    if (name === 'stop_video_recording') {
      const recording = this.recordings.get(params.recordingId);
      if (!recording) throw new Error('Unknown recording in this browser session.');
      await this.stop(recording, 'requested');
      return { ...result(this.describe(recording)), ...(recording.error ? { isError: true } : {}) };
    }
    const maxSeconds = params.maxSeconds ?? 120;
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new Error('maxSeconds must be an integer from 1 to 300.');
    if ([...this.recordings.values()].some(recording => ['recording', 'stopping'].includes(recording.state))) throw new Error('Stop this session’s active recording first.');
    if (this.recordings.size >= 100) throw new Error('Recording limit reached. Start a new browser session.');
    const pages = await this.availablePages(browser);
    const pageId = params.recordingPageId ?? (pages.length === 1 ? pages[0].recordingPageId : undefined);
    const page = this.pages.get(pageId);
    if (!page) throw new Error('Call list_video_recordings and supply a recordingPageId from its pages, or open exactly one tab in this session.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const recording = { id, page, path: join(this.directory, `${id}.webm`), state: 'recording', started: Date.now() };
    // Own the output stream so stop waits for the file to finish, not just ffmpeg.
    // Homebrew is not on launchd's PATH; use its absolute binary when present.
    try {
      recording.recorder = await page.screencast({ ffmpegPath: ffmpegPath(), fps: 15, format: 'webm' });
    } catch (error) {
      throw new Error(`Could not start video recording: ${errorText(error)}. Install ffmpeg on the Mac (brew install ffmpeg).`);
    }
    recording.output = pipeline(recording.recorder, createWriteStream(`${recording.path}.partial`, { flags: 'wx', mode: 0o600 }))
      .catch(error => { recording.error = errorText(error); void this.stop(recording, 'output-error'); });
    this.recordings.set(id, recording);
    recording.onClose = () => { void this.stop(recording, 'page-closed'); };
    page.once('close', recording.onClose);
    recording.timer = setTimeout(() => { void this.stop(recording, 'time-limit'); }, maxSeconds * 1000);
    recording.timer.unref();
    return result(this.describe(recording));
  }
  stop(recording, reason) {
    return recording.stopping ??= (async () => {
      recording.state = 'stopping';
      recording.reason = reason;
      clearTimeout(recording.timer);
      recording.page.off('close', recording.onClose);
      try {
        await recording.recorder.stop();
        await recording.output;
        recording.bytes = (await stat(`${recording.path}.partial`)).size;
        if (!recording.bytes) throw new Error('The recording contains no video frames.');
        if (!recording.error) await rename(`${recording.path}.partial`, recording.path);
      } catch (error) { recording.error ??= errorText(error); }
      recording.ended = Date.now();
      recording.state = recording.error ? 'failed' : 'saved';
    })();
  }
  async close() { await Promise.all([...this.recordings.values()].map(recording => this.stop(recording, 'session-ended'))); }
}

export const recordingTools = [
  { name: 'list_video_recordings', description: 'List this session’s videos and owned tabs with recordingPageId values (distinct from DevTools pageId). Files are on the Mac.', properties: {} },
  { name: 'start_video_recording', description: 'Record one owned Helium tab as a silent WebM. With one tab, omit recordingPageId; otherwise get it from list_video_recordings. Stops after maxSeconds or when the session ends. Requires ffmpeg on the Mac.',
    properties: { recordingPageId: { type: 'string', format: 'uuid' }, maxSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 120 } } },
  { name: 'stop_video_recording', description: 'Finish a video and return its Mac path and size. Safe to repeat. On Linux use remote-access recording fetch RECORDING_ID [DESTINATION] before attaching it to a PR.',
    properties: { recordingId: { type: 'string', format: 'uuid' } }, required: ['recordingId'] },
].map(({ properties, required = [], ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
