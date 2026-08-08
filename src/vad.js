// Energy-based voice activity detection over Int16LE mono PCM frames.
// Emits utterance boundaries so the app can flush speech to STT the moment
// someone stops talking instead of waiting for a fixed-interval timer.

class VAD {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 16000;
    this.frameMs = opts.frameMs || 20;
    this.frameSamples = Math.round((this.sampleRate * this.frameMs) / 1000);
    this.hangoverFrames = opts.hangoverFrames || 15; // keep this many silence frames as speech tail
    this.minSpeechFrames = opts.minSpeechFrames || 3; // ignore blips shorter than this
    this.sensitivity = opts.sensitivity || 0.55;      // multiplier applied to the noise floor for the threshold
    this.floor = opts.floor || 30;                    // absolute minimum RMS we ever treat as speech

    this.reset();
  }

  reset() {
    this.noise = this.floor;
    this.speech = false;
    this.tail = 0;
    this.speechFrames = 0;
    this.utterance = null; // Buffer accumulating current speech
  }

  // Push one Int16LE PCM Buffer (arbitrary length; it is cut into frames).
  // Returns an array of events: { type: 'utterance', samples } when speech ends.
  push(pcm) {
    const events = [];
    for (let off = 0; off < pcm.length; off += this.frameSamples * 2) {
      const frame = pcm.subarray(off, Math.min(off + this.frameSamples * 2, pcm.length));
      if (frame.length < 64) continue; // ignore tiny trailing fragment
      const rms = frameRms(frame);
      this.noise = 0.9 * this.noise + 0.1 * Math.max(this.floor, Math.min(rms, 3000));
      const threshold = this.noise * this.sensitivity;
      const isSpeech = rms > threshold && rms > this.floor;

      if (isSpeech) {
        if (!this.speech) this.speech = true;
        this.tail = 0;
        this.speechFrames++;
        this.utterance = this.utterance ? Buffer.concat([this.utterance, frame]) : Buffer.from(frame);
      } else if (this.speech) {
        this.tail++;
        if (this.tail >= this.hangoverFrames) {
          const samples = this.utterance || Buffer.alloc(0);
          if (this.speechFrames >= this.minSpeechFrames) events.push({ type: 'utterance', samples });
          this.speech = false;
          this.speechFrames = 0;
          this.utterance = null;
          this.tail = 0;
        } else if (this.utterance) {
          this.utterance = Buffer.concat([this.utterance, frame]);
        }
      }
    }
    return events;
  }

  // Call when capture stops to force-close a hanging utterance.
  flush() {
    if (this.speech) {
      const valid = this.speechFrames >= this.minSpeechFrames;
      const ev = { type: 'utterance', samples: this.utterance || Buffer.alloc(0) };
      this.reset();
      return valid ? [ev] : [];
    }
    return [];
  }

  get speaking() { return this.speech; }
}

function frameRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) {
    const s = frame.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / (frame.length / 2));
}

module.exports = { VAD };
