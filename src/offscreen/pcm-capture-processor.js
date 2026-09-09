// AudioWorklet processor: mixes tab audio to mono, resamples to 16 kHz
// 16-bit PCM, and posts ~100 ms (1600-sample) chunks to the offscreen page.
// Plain JS (not TypeScript): loaded via audioWorklet.addModule() and copied
// to dist/ as-is by scripts/copy-assets.mjs.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input samples per output sample, e.g. 3 at a 48 kHz device rate.
    this._ratio = sampleRate / TARGET_RATE;
    // Fractional read position inside the current input block.
    this._pos = 0;
    // Last mono sample of the previous block, for interpolation across blocks.
    this._prev = 0;
    this._hasPrev = false;
    this._pending = new Int16Array(CHUNK_SAMPLES);
    this._pendingCount = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const frames = channels[0].length;
    const numChannels = channels.length;

    // Mono mix of this block.
    const mono = new Float32Array(frames);
    for (let c = 0; c < numChannels; c++) {
      const ch = channels[c];
      for (let i = 0; i < frames; i++) mono[i] += ch[i] / numChannels;
    }

    // Linear interpolation between sample index (pos-1) and pos, where
    // index -1 refers to the last sample of the previous block.
    let pos = this._pos;
    while (pos < frames) {
      const whole = Math.floor(pos);
      const frac = pos - whole;
      const a = whole - 1 >= 0 ? mono[whole - 1] : this._hasPrev ? this._prev : mono[0];
      const b = mono[whole];
      const value = a + (b - a) * frac;
      const clamped = Math.max(-1, Math.min(1, value));
      this._pending[this._pendingCount++] = Math.round(clamped * 32767);
      if (this._pendingCount >= CHUNK_SAMPLES) this._flush();
      pos += this._ratio;
    }
    // Carry the overshoot into the next block.
    this._pos = pos - frames;
    this._prev = mono[frames - 1];
    this._hasPrev = true;
    return true; // Keep the processor alive.
  }

  _flush() {
    const out = this._pending;
    this._pending = new Int16Array(CHUNK_SAMPLES);
    this._pendingCount = 0;
    // Transfer (not copy) the buffer to the offscreen page.
    this.port.postMessage({ type: 'pcm16', pcm: out.buffer }, [out.buffer]);
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
