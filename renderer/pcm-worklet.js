// AudioWorklet processor: converts float32 frames to mono Int16LE and posts
// them to the renderer thread. Runs off the main thread (no UI blocking).
// The renderer registers a message handler that forwards buffers via IPC.

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = () => {}; // extraction control handled by caller channel
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch0 = input[0];
    const out = new Int16Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      const s = Math.max(-1, Math.min(1, ch0[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor('cue-pcm-processor', PCMProcessor);