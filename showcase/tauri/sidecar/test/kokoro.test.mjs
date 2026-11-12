import assert from 'node:assert/strict';
import { KokoroVoice, FakeSplitter, KOKORO_VOICES, RATE, DEFAULT_VOICE, KOKORO_MODEL, setTTS } from '../kokoro.mjs';

// A stand-in for the loaded KokoroTTS model: its stream() consumes a FakeSplitter, one piece per
// pushed chunk, like the real model (which yields a Float32Array in [-1, 1] per generated piece).
// pieces: audio per chunk; fail: throw after this many chunks; hang: never yield anything;
// stopAfter: go quiet after this many pieces (the model stalls mid-reply).
const fakeTTS = ({ pieces = [], fail = Infinity, hang = false, stopAfter = Infinity } = {}) => ({
  opened: 0,
  async *stream(splitter) {
    this.opened++;
    if (hang) await new Promise(() => {}); // the model never produces audio
    for (let i = 0;;) {
      while (i >= splitter.chunks.length && splitter.open) await new Promise((r) => setTimeout(r, 0));
      if (i >= splitter.chunks.length) return; // splitter closed and drained
      const text = splitter.chunks[i++];
      if (i > fail) throw new Error('the model blew up');
      if (i > stopAfter) await new Promise(() => {});
      const audio = pieces[i - 1] ?? [0.5];
      yield { text, audio: new Float32Array(audio) };
    }
  },
});
const tick = () => new Promise((r) => setTimeout(r, 0));
// A voice over a fake model, driven to the end. Collect everything the handlers get.
const run = async ({ text = ['Hi.'], pieces, fail, hang, end = true, audioTimeout = 2000, voice = 'af_heart' } = {}) => {
  const got = { audio: [], end: 0, errors: [] };
  const tts = fakeTTS({ pieces, fail, hang });
  const v = new KokoroVoice({ voice, ttsImpl: tts, audioTimeout, onAudio: (pcm) => got.audio.push(pcm), onEnd: () => got.end++, onError: (e) => got.errors.push(e) });
  for (const t of text) v.say(t);
  if (end) v.end();
  for (let i = 0; i < 200 && !got.end && !got.errors.length; i++) await tick();
  return { v, tts, ...got };
};

{ // Constants, so a voice rename is caught by tests rather than silence at run time.
  assert.equal(RATE, 24000);
  assert.equal(DEFAULT_VOICE, 'af_heart');
  assert.equal(KOKORO_MODEL, 'onnx-community/Kokoro-82M-v1.0-ONNX');
  assert.ok(KOKORO_VOICES.some((v) => v.id === DEFAULT_VOICE), 'the default voice is one on offer');
  assert.equal(new Set(KOKORO_VOICES.map((v) => v.id)).size, KOKORO_VOICES.length, 'voice ids are unique');
  for (const v of KOKORO_VOICES) assert.match(v.id, /^[ab][fm]_\w+$/, `${v.id} is a Kokoro voice name`);
}
{ // Say → audio → onEnd: 24 kHz Int16 samples, floats scaled and clamped.
  const { v, audio, end, errors } = await run({ pieces: [[0.5, -1.5, 0]] });
  assert.deepEqual([...audio[0]], [16384, -32768, 0]); // Math.round(16383.5); -1.5 clamps
  assert.equal(end, 1);
  assert.deepEqual(errors, []);
  assert.equal(v.state, 'done');
}
{ // Two sentences stream in order, one piece each.
  const { audio } = await run({ text: ['Hello there.', 'How are you?'], pieces: [[1], [2, 3]] });
  assert.deepEqual([...audio[0]], [32767]);
  assert.deepEqual([...audio[1]], [32767, 32767]); // every value over 1.0 clamps to the top
}
{ // Kokoro has no cue support (Fish acted [happy] and friends out), so cues are stripped before the phonemizer.
  const { v } = await run({ text: ['[warm] Hi. [happy]'] });
  assert.deepEqual(v.splitter.chunks, ['Hi.'], 'cues go, wording stays; a cue-only line pushes nothing');
}
{ // Whitespace collapses, so a cue left a gap never reaches the phonemizer.
  const { v } = await run({ text: ['[happy]   Hello   there.'] });
  assert.deepEqual(v.splitter.chunks, ['Hello there.']);
}
{ // end() with nothing said ends at once, without ever opening the stream.
  const { v, tts, end } = await run({ text: [], end: true });
  assert.equal(end, 1);
  assert.equal(tts.opened, 0);
  assert.equal(v.state, 'done');
}
{ // Text that arrives while the model is still loading (state 'new') is queued, then spoken.
  const got = { audio: [], end: 0, errors: [] };
  const v = new KokoroVoice({ ttsImpl: fakeTTS(), onAudio: (p) => got.audio.push(p), onEnd: () => got.end++, onError: (e) => got.errors.push(e) });
  v.say('Hi.'); // the model is still opening; the line queues
  for (let i = 0; i < 200 && !v.splitter; i++) await tick();
  assert.ok(v.splitter, 'the stream opened');
  v.end();
  for (let i = 0; i < 200 && !got.end; i++) await tick();
  assert.equal(got.end, 1);
  assert.equal(got.audio.length, 1);
}
{ // abort() stops at once and silently: no further audio, no onEnd, no onError.
  const got = { audio: [], end: 0, errors: [] };
  const tts = fakeTTS({ pieces: [[1], [2]] });
  const v = new KokoroVoice({ ttsImpl: tts, onAudio: (p) => got.audio.push(p), onEnd: () => got.end++, onError: (e) => got.errors.push(e) });
  v.say('Hi.');
  for (let i = 0; i < 200 && !got.audio.length; i++) await tick();
  v.abort();
  v.say('More.'); // after abort this is a no-op
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(got.end, 0);
  assert.deepEqual(got.errors, []);
  assert.equal(v.state, 'done');
  assert.deepEqual(v.splitter.chunks, ['Hi.'], 'nothing more was pushed');
}
{ // A model failure becomes onError, with heard saying whether any audio got out.
  const { errors } = await run({ fail: 0 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].heard, false);
  assert.match(errors[0].message, /blew up/);
}
{ // A failure after audio went out keeps heard true.
  const { errors, audio } = await run({ text: ['One.', 'Two.'], pieces: [[1], [2]], fail: 1 });
  assert.equal(audio.length, 1);
  assert.equal(errors[0].heard, true);
}
{ // The model going quiet trips the audio timeout, not a silent hang.
  const { errors } = await run({ hang: true, audioTimeout: 20 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /took too long to start/);
}
{ // A voice that stops mid-reply trips the running timeout.
  const got = { errors: [], audio: 0 };
  const tts = fakeTTS({ stopAfter: 1 });
  const v = new KokoroVoice({ ttsImpl: tts, audioTimeout: 30, onAudio: () => got.audio++, onError: (e) => got.errors.push(e) });
  v.say('One.');
  for (let i = 0; i < 200 && !got.audio; i++) await tick();
  v.say('Two.'); // the model goes quiet here
  for (let i = 0; i < 200 && !got.errors.length; i++) await tick();
  assert.match(got.errors[0]?.message ?? '', /stopped sending audio/);
}
{ // An unknown voice name falls back to the default, so a renamed voice never breaks speech.
  const { v } = await run({ voice: 'not_a_voice' });
  assert.equal(v.voice, DEFAULT_VOICE);
}
{ // FakeSplitter is the stand-in behind ttsImpl: it records what the voice pushes.
  const s = new FakeSplitter();
  s.push('a'); s.push('b');
  let closed = 0;
  s.onclose = () => closed++;
  s.close(); s.push('late');
  assert.deepEqual(s.chunks, ['a', 'b']);
  assert.equal(closed, 1);
  assert.equal(s.open, false);
}
{ // setTTS (the test seam) stands in for the loaded model, so nothing here touches the real download.
  const tts = fakeTTS();
  setTTS(tts);
  assert.equal(tts.opened, 0, 'a test voice with ttsImpl set never calls the real model');
}
console.log('kokoro tests: passed');
