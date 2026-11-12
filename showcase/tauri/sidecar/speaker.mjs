// Speaks replies with Kokoro-82M local TTS and hands the audio to the overlay ({ kind: 'speech' } messages).
// - Kokoro runs 100% locally via ONNX Runtime, no API key needed. Output is 24 kHz mono PCM.
// - Each reply has its own id, so audio from one that was stopped can never play over the next.
// - Beats: when something slow starts (a web search, a page, the screen) and the model hasn't said anything,
//   a short line ("One sec.", "On it." and 32 more, picked at random) plays so it's never silent. They're made once
//   in the voice and kept, so they play instantly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE, KokoroVoice, RATE, kokoroTTS } from './kokoro.mjs';

// One or two words each, so a beat never sounds canned; any of them must fit before a search, a page, the screen or a drawing.
export const BEATS = [
  'One sec.', 'On it.', 'Hang on.', 'Hold on.', 'Got it.', 'Okay.', 'Sure.', 'Right.', 'Alright.', 'Gotcha.',
  'Checking.', "Let's see.", 'Sure thing.', 'Coming up.', 'Sec.', 'One moment.', 'Bear with.', 'Hmm, okay.', 'Got you.', 'Right, sec.',
  'Sure, sec.', 'Okay, sec.', 'Roger.', 'Yep.', 'Yep, sec.', 'Two secs.', 'Hold tight.', 'Mm-hmm.', 'Will do.', 'Righto.',
  'Moment.', 'Okay, checking.', 'Sure, checking.', 'Okie-dokie.',
];
const BEAT_PHRASES = BEATS;
const RECENT = 8; // a beat isn't picked again until this many others have played

// The beats shipped with the app (beats/make.mjs), next to this file or the bundle: voice → Map of phrase → { rate, pcm }
// (base64), or null for a voice not recorded.
export function bundledBeats(dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'beats')) {
  let index = null;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return () => null; }
  const sets = new Map();
  return (voice) => {
    const k = voice, set = index.sets?.[k];
    if (!set) return null;
    if (!sets.has(k)) {
      let all = null;
      try { all = fs.readFileSync(path.join(dir, set.file)); } catch {}
      sets.set(k, all && new Map(Object.entries(set.beats).map(([phrase, [at, n]]) => [phrase, { rate: index.rate, pcm: all.subarray(at, at + n).toString('base64') }])));
    }
    return sets.get(k);
  };
}

export function createSpeaker({ emit, onProblem = () => {}, log = () => {}, KokoroVoiceImpl = KokoroVoice, beatPhrases = BEAT_PHRASES, bundled = bundledBeats(), ttsImpl = null }) {
  let voice = DEFAULT_VOICE, modelReady = false, seq = 0, current = null, warming = null;
  let beats = new Map(), recent = []; // phrase → [base64 PCM chunks], for the current voice
  const makeVoice = (handlers) => new KokoroVoiceImpl({ voice, ttsImpl, ...handlers });
  // A random beat, not one of the last few: one that's already made if there is one, so it plays instantly.
  const shipped = () => bundled(voice);
  const ready = (p) => beats.has(p) || !!shipped()?.has(p);
  const pickBeat = () => {
    const fresh = beatPhrases.filter((p) => !recent.includes(p));
    const pool = [fresh.filter(ready), beatPhrases.filter(ready), fresh, beatPhrases].find((x) => x.length);
    const phrase = pool?.[Math.floor(Math.random() * pool.length)] ?? BEAT_PHRASES[0];
    recent = [...recent, phrase].slice(-Math.min(RECENT, Math.max(0, beatPhrases.length - 1)));
    return phrase;
  };

  // Make the beats once, one at a time. Failures just leave a gap: that beat is then spoken live instead.
  function warm() {
    const vo = voice;
    warming ??= (async () => {
      // Ensure the model is loaded first (a stand-in skips this).
      if (!ttsImpl) { try { await kokoroTTS(); } catch { return; } }
      for (const phrase of beatPhrases) {
        if (voice !== vo) break;
        if (beats.has(phrase) || bundled(vo)?.has(phrase)) continue; // shipped with the app
        const chunks = await new Promise((done) => {
          const got = [];
          const v = makeVoice({ onAudio: (pcm) => got.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')), onEnd: () => done(got), onError: () => done(null) }).open();
          v.say(phrase); v.end();
        });
        if (chunks?.length && voice === vo) beats.set(phrase, chunks);
      }
    })().finally(() => { warming = null; });
    return warming;
  }

  function stopAll() {
    if (current) { current.abort(); current = null; }
    emit({ kind: 'speech', stop: true });
  }

  /** A new reply's voice. say(sentence) as they come, then end(). */
  function start() {
    if (!modelReady) return null; // Kokoro not loaded yet
    stopAll();
    const id = `s${++seq}`, said = [];
    let ended = false, v = null, heard = false, done = false, beat = false, t0 = Date.now();
    const me = {
      id,
      say(s) { if (done) return; said.push(s); v?.say(s); },
      /** Something slow is starting: a short beat, unless it's already said something. */
      beat() {
        if (done || beat || said.length || heard) return false;
        beat = true;
        const phrase = pickBeat(), shippedBeat = shipped()?.get(phrase), chunks = beats.get(phrase);
        if (!shippedBeat && !chunks) { me.say(phrase); return true; }
        log('speech_beat', { id, ms: Date.now() - t0 });
        if (shippedBeat) emit({ kind: 'speech', id, rate: shippedBeat.rate, pcm: shippedBeat.pcm });
        else for (const pcm of chunks) emit({ kind: 'speech', id, rate: RATE, pcm });
        return true;
      },
      end() { if (done || ended) return; ended = true; v?.end(); },
      abort() { if (done) return; done = true; v?.abort(); if (current === me) current = null; },
    };
    const finish = (whole = false) => {
      if (done) return;
      done = true;
      const chars = whole && heard ? said.join(' ').replace(/\[[^\]]*\]\s*/g, '').length : 0;
      emit({ kind: 'speech', id, end: true, ...(chars ? { chars } : {}) });
      if (current === me) current = null;
    };
    v = makeVoice({
      onAudio: (pcm) => {
        if (done) return;
        if (!heard) { heard = true; log('speech_first_audio', { id, ms: Date.now() - t0 }); }
        emit({ kind: 'speech', id, rate: RATE, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
      },
      onEnd: () => finish(true),
      onError: (err) => {
        if (done) return;
        log('speech_error', { id, heard: err.heard, message: err.message });
        if (!heard) onProblem(err.message);
        finish();
      },
    }).open();
    log('speech_start', { id });
    current = me;
    return me;
  }

  return {
    /** Load Kokoro in the background. Call once at startup. */
    async startModel() {
      if (modelReady) return;
      try {
        if (!ttsImpl) await kokoroTTS();
        modelReady = true;
        warm();
        log('kokoro_ready', {});
      } catch (e) {
        log('kokoro_error', { message: e.message });
      }
    },
    /** The user's selected voice (a Kokoro voice name like 'af_heart'). */
    setVoice(v) {
      if ((v || DEFAULT_VOICE) !== voice) beats = new Map();
      voice = v || DEFAULT_VOICE;
      if (modelReady) warm();
    },
    get voice() { return voice; },
    get ready() { return beats.size + beatPhrases.filter((p) => !beats.has(p) && shipped()?.has(p)).length; },
    get on() { return modelReady; },
    start,
    stop: stopAll,
  };
}