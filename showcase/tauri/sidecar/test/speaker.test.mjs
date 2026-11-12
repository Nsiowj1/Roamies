import assert from 'node:assert/strict';
import { createSpeaker, BEATS, bundledBeats } from '../speaker.mjs';
import { RATE, DEFAULT_VOICE, setTTS } from '../kokoro.mjs';

// A stand-in for the KokoroTTS model: stream() consumes a FakeSplitter, one piece per chunk,
// then closes. Unlike ttsImpl = {} (broken — no stream()), this never calls the real model.
const fakeTTS = (pieces = [[1]]) => ({
  async *stream(splitter) {
    for (let i = 0;;) {
      while (i >= splitter.chunks.length && splitter.open) await new Promise((r) => setTimeout(r, 0));
      if (i >= splitter.chunks.length) return;
      splitter.chunks[i++]; // discard
      yield { text: splitter.chunks[i - 1], audio: new Float32Array(pieces[Math.min(i - 1, pieces.length - 1)]) };
    }
  },
});

// A KokoroVoice stand-in the test drives by hand. Like the real KokoroVoice, end() does not
// fire onEnd: the model keeps streaming until the test calls onAudio/onEnd/onError itself.
const made = [];
class FakeVoice {
  constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; this.aborted = false; made.push(this); }
  open() { return this; }
  say(s) { this.said.push(s); }
  end() { this.ended = true; }
  abort() { this.aborted = true; }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// fakeTTS: a proper KokoroTTS stand-in with a working stream() — unlike ttsImpl = {} (broken).
const setup = (beatPhrases = [], bundled = () => null, fakeModel = fakeTTS()) => {
  made.length = 0;
  setTTS(fakeModel); // always inject so startModel() uses the fake, never the real model
  const out = [], problems = [], logs = [];
  const sp = createSpeaker({ emit: (m) => out.push(m), onProblem: (p) => problems.push(p), log: (k, v) => logs.push([k, v]), KokoroVoiceImpl: FakeVoice, beatPhrases, bundled, ttsImpl: null });
  return { sp, out, problems, logs };
};
// Let the background beat-making (warm) run: drive each FakeVoice it makes to the end.
const warmUp = async (sp, n) => {
  for (let i = 0; i < 100 && sp.ready < n; i++) {
    while (made.length) { const v = made.shift(); v.onAudio?.(new Int16Array([7])); v.onEnd(); }
    await tick();
  }
};

{ // No model, no voice: Kokoro isn't loaded yet.
  const { sp } = setup();
  assert.equal(sp.on, false);
  assert.equal(sp.start(), null);
}
{ // startModel loads Kokoro (a stand-in here), then replies speak.
  const { sp, out } = setup();
  await sp.startModel();
  assert.equal(sp.on, true);
  const v = sp.start();
  assert.ok(v);
  assert.equal(sp.voice, DEFAULT_VOICE);
  v.say('Hello.'); v.end();
  assert.deepEqual(made[0].said, ['Hello.']);
  made[0].onAudio(new Int16Array([1, 2])); made[0].onEnd();
  assert.deepEqual(out, [
    { kind: 'speech', stop: true },
    { kind: 'speech', id: 's1', rate: RATE, pcm: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64') },
    { kind: 'speech', id: 's1', end: true, chars: 6 },
  ]);
}
{ // A reply that never made a sound is a problem; one that did is not.
  const { sp, problems } = setup();
  await sp.startModel();
  let v = sp.start();
  v.end(); made[0].onError(Object.assign(new Error('Kokoro blew up'), { heard: false }));
  assert.deepEqual(problems, ['Kokoro blew up']);
  v = sp.start();
  v.end(); made[1].onAudio(new Int16Array([1])); made[1].onError(Object.assign(new Error('late'), { heard: true }));
  assert.deepEqual(problems, ['Kokoro blew up']);
  // The end still goes out either way, so the bubble never hangs: with audio, chars are counted.
  assert.equal(sp.start().id, 's3');
}
{ // Cues are counted out of the character bill: they're for bubbles, not the ear.
  const { sp, out } = setup();
  await sp.startModel();
  const v = sp.start();
  v.say('[warm] Hello there.'); v.end();
  made[0].onAudio(new Int16Array([1])); made[0].onEnd();
  assert.equal(out.find((m) => m.end).chars, 12, "'[warm] Hello there.' is billed as 'Hello there.'");
}
{ // A new reply stops the running one; stop() stops the running one and quiets the overlay.
  const { sp, out } = setup();
  await sp.startModel();
  const v = sp.start();
  sp.start();
  assert.equal(made[0].aborted, true, 'start() stops the previous reply');
  sp.stop();
  assert.equal(made[1].aborted, true);
  assert.equal(out.filter((m) => m.stop && !m.id).length, 3, 'each of the two starts and the stop tell the overlay to go quiet');
}
{ // A beat goes out instantly when it's shipped with the app, and never before the model said anything.
  const shipped = new Map([['One sec.', { rate: RATE, pcm: 'abc' }]]);
  const { sp, out } = setup(['One sec.'], () => shipped); // deterministic: only one phrase, and it's shipped
  await sp.startModel();
  const v = sp.start();
  made.length = 0; // zero out the voice that start() makes; we're testing the beat path
  assert.equal(v.beat(), true);
  assert.ok(out.some((m) => m.id === 's1' && m.pcm === 'abc' && m.rate === RATE), 'the shipped beat goes out under the reply id');
  assert.equal(made.length, 0, 'a shipped beat needs no voice of its own');
  assert.equal(v.beat(), false, 'only one beat per reply');
  v.say('Hi');
  assert.equal(v.beat(), false, 'never a beat after the model said something');
}
{ // Without a shipped beat, the beat is spoken live through the voice.
  const { sp } = setup(['On it.']);
  await sp.startModel();
  const v = sp.start();
  assert.equal(v.beat(), true);
  assert.deepEqual(made[0].said, ['On it.']);
}
{ // Beats are made once in the current voice (the first ones during startModel), then played instantly.
  const phrases = ['One sec.', 'On it.', 'Checking.'];
  const { sp, out } = setup(phrases, () => null);
  await sp.startModel();
  assert.equal(sp.ready, 0, 'no beats are cached until warm() makes them');
  await warmUp(sp, phrases.length);
  assert.equal(sp.ready, phrases.length);
  const v = sp.start();
  const before = made.length;
  assert.equal(v.beat(), true);
  assert.equal(made.length, before, 'the beat plays from the cache; it needs no voice of its own');
  assert.ok(out.some((m) => m.pcm && m.id === v.id && !m.end), 'the cached beat audio went out under the reply id');
  // And changing the voice remakes them.
  made.length = 0;
  sp.setVoice('am_fenrir');
  assert.equal(sp.voice, 'am_fenrir');
  await warmUp(sp, phrases.length);
  assert.equal(made.every((v) => v.voice === 'am_fenrir'), true);
  // An empty or unknown voice name falls back to the default.
  sp.setVoice('');
  assert.equal(sp.voice, DEFAULT_VOICE);
}
{ // Bundled beats: the index next to this file has none yet (they're recorded on a machine with the model).
  const bundled = bundledBeats();
  assert.equal(bundled(DEFAULT_VOICE), null, 'no af_heart beats are recorded yet');
  assert.equal(bundled('nobody'), null);
  const missing = bundledBeats('/no/such/dir');
  assert.equal(missing(DEFAULT_VOICE), null, 'a missing beats folder means none shipped');
}
{ // Beat logging names the moment the beat played.
  const shipped = new Map([['Okay.', { rate: RATE, pcm: 'z' }]]);
  const { sp, logs } = setup(BEATS, () => shipped);
  await sp.startModel();
  const v = sp.start();
  v.beat();
  assert.deepEqual(logs.find(([k]) => k === 'speech_beat')[0], 'speech_beat');
}
{ // The default beat phrases are short, so a beat never sounds canned.
  assert.ok(BEATS.length >= 30);
  for (const p of BEATS) assert.ok(p.length <= 16, `"${p}" stays short`);
}
console.log('speaker tests: passed');
