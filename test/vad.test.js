const test = require('node:test');
const assert = require('node:assert');
const { VAD } = require('../src/vad');

function tone(rms, nSamples, base = 0) {
  const buf = Buffer.alloc(nSamples * 2);
  for (let i = 0; i < nSamples; i++) {
    const s = Math.sign(Math.sin(i / 10)) * rms;
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}
function silence(nSamples) { return Buffer.alloc(nSamples * 2); }

test('VAD emits an utterance when speech ends after silence', () => {
  const vad = new VAD({ sampleRate: 16000 });
  // ~0.5s speech then 0.6s silence (> hangoverFrames at 20ms)
  vad.push(tone(5000, 5000, 8000));
  const evs = vad.push(silence(16000 * 0.6));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].type, 'utterance');
});

test('VAD ignores short blips below minSpeechFrames', () => {
  const vad = new VAD({ sampleRate: 16000, minSpeechFrames: 3 });
  const evs = vad.push(tone(5000, 5000, 640)); // ~40ms of tone -> 2 frames
  assert.strictEqual(evs.length, 0);
});

test('VAD ignores pure silence', () => {
  const vad = new VAD({ sampleRate: 16000 });
  const evs = vad.push(silence(16000));
  assert.strictEqual(evs.length, 0);
  assert.strictEqual(vad.speaking, false);
});

test('VAD flush forces an open utterance closed', () => {
  const vad = new VAD({ sampleRate: 16000 });
  vad.push(tone(5000, 5000, 8000));
  const evs = vad.flush();
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(vad.speaking, false);
});