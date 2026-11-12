// Spoken replies through Kokoro-82M, run locally (Apache-2.0, hexgrad/Kokoro-82M via the kokoro-js package,
// which drives the ONNX export onnx-community/Kokoro-82M-v1.0-ONNX through @huggingface/transformers).
// The model (~360 MB, q8) is fetched once by transformers.js into its cache on first use; nothing is sent
// anywhere at run time. Output is 24 kHz mono PCM, streamed one chunk per generated piece.
//
// kokoro-js and its engine stay external in the bundle and load lazily: if they're missing (an app build
// without the local voice packages), spoken replies just stay off instead of taking the sidecar down.
import { CUE } from './speech.mjs';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const RATE = 24000; // Kokoro's native output rate (Fish's was 44100)
export const DEFAULT_VOICE = 'af_heart';

// The voices to offer (Settings > Voice). id: a Kokoro voice name; grade: the model card's quality grade.
export const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', grade: 'A' },
  { id: 'af_bella', name: 'Bella', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', grade: 'B-' },
  { id: 'af_sarah', name: 'Sarah', grade: 'C+' },
  { id: 'af_sky', name: 'Sky', grade: 'C-' },
  { id: 'af_aoede', name: 'Aoede', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', grade: 'C+' },
  { id: 'af_nova', name: 'Nova', grade: 'C' },
  { id: 'am_michael', name: 'Michael', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', grade: 'C+' },
  { id: 'am_adam', name: 'Adam', grade: 'F+' },
  { id: 'bf_emma', name: 'Emma', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', grade: 'C' },
  { id: 'bm_george', name: 'George', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', grade: 'C' },
];
const VOICE_OK = new Set(KOKORO_VOICES.map((v) => v.id));

let mod = null, loadFailed = false;
/** The loaded kokoro-js module ({ KokoroTTS, TextSplitterStream }), or null while loading / on failure. */
async function load() {
  if (mod) return mod;
  if (loadFailed) return null;
  try { mod = await import('kokoro-js'); } catch (e) { loadFailed = true; throw e; }
  return mod;
}

let _tts = null, _loading = null;
/** The KokoroTTS model, loaded once (CPU). Fetches the ONNX files on first run. Never throws. */
export function kokoroTTS() {
  if (_tts) return Promise.resolve(_tts);
  _loading ??= (async () => {
    const m = await load();
    const tts = await m.KokoroTTS.from_pretrained(KOKORO_MODEL, { device: 'cpu', dtype: 'q8' });
    _tts = tts;
    return tts;
  })().catch((e) => { _loading = null; throw e; });
  return _loading;
}

/** Only for tests: stand in for the loaded model. */
export function setTTS(tts) { _tts = tts; _loading = Promise.resolve(tts); }

/**
 * One reply's voice. say(sentence) as they come, then end(). abort() stops at once, silently.
 * onAudio(Int16Array) gets PCM (whole 16-bit samples at RATE); onEnd() once after the last audio;
 * onError(err) instead of onEnd when it fails (heard = whether any audio had arrived).
 */
export class KokoroVoice {
  constructor({ voice = DEFAULT_VOICE, onAudio, onEnd, onError, ttsImpl = null, audioTimeout = 20000 }) {
    Object.assign(this, { voice: VOICE_OK.has(voice) ? voice : DEFAULT_VOICE, onAudio, onEnd, onError, ttsImpl, audioTimeout });
    this.queue = []; // sentences waiting for the model
    this.state = 'new'; // new → opening → open → ending → done
    this.heard = false;
    this.said = 0;
    this.timer = null;
  }

  open() {
    if (this.state !== 'new') return this;
    this.state = 'opening';
    this.arm(this.audioTimeout, 'Kokoro took too long to start');
    this._open().catch((e) => this.fail(e));
    return this;
  }

  async _open() {
    const tts = this.ttsImpl ?? await kokoroTTS().catch(() => null);
    if (!tts || this.state === 'done') return this.fail(new Error('The voice model is not available'));
    this.splitter = new (this.ttsImpl ? FakeSplitter : (await load()).TextSplitterStream)();
    // The consumer drains the splitter as the model finishes each piece; the loop ends when end()
    // closes the splitter, and that ends the stream.
    this.consumer = this._consume(tts);
    this.consumer.next();
    if (this.state === 'done') return;
    if (this.state !== 'ending') this.state = 'open'; // end() during the load still ends
    await this._drain();
  }

  async *_consume(tts) {
    try {
      for await (const piece of tts.stream(this.splitter)) {
        if (this.state === 'done') return;
        const audio = piece?.audio;
        if (audio?.length) {
          this.heard = true;
          const pcm = new Int16Array(audio.length);
          for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32767)));
          this.onAudio?.(pcm);
        }
      }
      this.finish();
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Send everything queued; when ending and nothing is left, close the splitter so the stream can finish.
  // Kokoro has no cue support (Fish acted [happy] and friends out), so cues are dropped before the phonemizer.
  async _drain() {
    while (this.queue.length && this.state !== 'done' && this.splitter) {
      const t = this.queue.shift().replace(CUE, '').replace(/\s+/g, ' ').trim();
      if (t) this.splitter.push(t);
    }
    if (this.state === 'ending' && this.splitter && !this.closed) { this.closed = true; this.splitter.close(); }
  }

  say(text) {
    if (this.state === 'done' || this.state === 'ending' || !text) return;
    this.said++;
    this.queue.push(text); // first, so the open below drains it right away
    if (this.state === 'new') return void this.open();
    if (this.state === 'opening') return; // _open flushes the queue once the model is up
    this.arm(this.audioTimeout, 'Kokoro stopped sending audio');
    this._drain().catch((e) => this.fail(e));
  }

  end() {
    if (this.state === 'done' || this.state === 'ending') return;
    if (!this.said && !this.heard) return this.close(), this.onEnd?.(); // nothing to say
    this.state = 'ending';
    if (!this.timer) this.arm(this.audioTimeout, 'Kokoro stopped sending audio');
    this._drain().catch((e) => this.fail(e));
  }

  abort() { this.close(); }

  arm(ms, why) { this.clear(); this.timer = setTimeout(() => this.fail(new Error(why)), ms); }
  clear() { clearTimeout(this.timer); this.timer = null; }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.clear();
    this.queue.length = 0;
    try { if (this.splitter && !this.closed) { this.closed = true; this.splitter.close(); } } catch { /* already closed */ }
    this.consumer?.return?.().catch?.(() => {});
  }

  finish() { if (this.state === 'done') return; this.close(); this.onEnd?.(); }

  fail(err) {
    if (this.state === 'done') return;
    this.close();
    err.heard = this.heard;
    this.onError?.(err);
  }
}

// Test stand-in for TextSplitterStream: replays queued text through a script of pieces.
export class FakeSplitter {
  constructor() { this.chunks = []; this.open = true; this.onclose = null; }
  push(t) { if (this.open) this.chunks.push(t); }
  close() { this.open = false; this.onclose?.(); }
}
