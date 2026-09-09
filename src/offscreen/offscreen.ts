// Offscreen dubbing engine. This hidden page is the only place that holds
// media: it redeems the tab-capture stream id, plays the original audio back
// (capturing a tab mutes it for the speakers), streams 16 kHz PCM to Gemini
// Live Translate, and plays the 24 kHz dubbed voice on top.
import {
  type OffscreenStatusMessage,
  type SessionStatus,
  type SwToOffscreenMessage,
} from '../shared/messages.js';
import {
  buildAudioMessage,
  buildLiveEndpoint,
  buildSetupMessage,
  decodeBase64ToInt16,
  encodeInt16ToBase64,
  extractErrorText,
  extractOutputAudioBase64,
  isSetupCompleteMessage,
  parseServerMessage,
  OUTPUT_SAMPLE_RATE_HZ,
} from '../shared/gemini.js';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

interface ProcessorMessage {
  type: 'pcm16';
  pcm: ArrayBuffer;
}

function isProcessorMessage(event: MessageEvent): event is MessageEvent<ProcessorMessage> {
  const data = event.data as Partial<ProcessorMessage> | undefined;
  return !!data && data.type === 'pcm16' && data.pcm instanceof ArrayBuffer;
}

class DubEngine {
  private captureStream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private keepAliveGain: GainNode | null = null;
  private originalGain: GainNode | null = null;

  private dubbedGain: GainNode | null = null;
  private nextDubbedStart = 0;

  private ws: WebSocket | null = null;
  private setupComplete = false;
  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private droppedWhileDown = 0;
  private chunksSent = 0;
  private audioChunksReceived = 0;

  private apiKey = '';
  private targetLanguage = '';

  async start(options: {
    streamId: string;
    targetLanguage: string;
    apiKey: string;
    originalVolume: number;
    dubbedVolume: number;
  }): Promise<void> {
    this.stopInternal();
    this.stopped = false;
    this.targetLanguage = options.targetLanguage;
    this.reconnectAttempts = 0;
    this.droppedWhileDown = 0;
    this.chunksSent = 0;
    this.audioChunksReceived = 0;

    if (!options.apiKey) throw new Error('No Gemini API key saved. Paste it in the popup first.');
    this.apiKey = options.apiKey;

    // Redeem the one-time stream id for the real tab audio.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: options.streamId },
      },
      video: false,
    } as unknown as MediaStreamConstraints);
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('That tab is not producing any audio. Play a video, then try again.');
    }
    this.captureStream = stream;

    this.captureCtx = new AudioContext();
    await this.captureCtx.resume();
    const source = this.captureCtx.createMediaStreamSource(stream);

    // Capturing mutes the tab, so play the original back ourselves.
    this.originalGain = this.captureCtx.createGain();
    this.originalGain.gain.value = options.originalVolume;
    source.connect(this.originalGain);
    this.originalGain.connect(this.captureCtx.destination);

    // Tap the same source for 16 kHz PCM via the AudioWorklet resampler.
    // The node is routed through a zero gain so it stays in the audio graph.
    await this.captureCtx.audioWorklet.addModule('pcm-capture-processor.js');
    this.captureNode = new AudioWorkletNode(this.captureCtx, 'pcm-capture-processor');
    this.keepAliveGain = this.captureCtx.createGain();
    this.keepAliveGain.gain.value = 0;
    source.connect(this.captureNode);
    this.captureNode.connect(this.keepAliveGain);
    this.keepAliveGain.connect(this.captureCtx.destination);
    this.captureNode.port.onmessage = (event: MessageEvent) => this.onPcmChunk(event);

    // Dubbed voice plays through the same context. Buffers are created at
    // 24 kHz and Web Audio resamples them to the device rate; chunks are
    // chained with start() times so playback is gapless.
    this.dubbedGain = this.captureCtx.createGain();
    this.dubbedGain.gain.value = options.dubbedVolume;
    this.dubbedGain.connect(this.captureCtx.destination);
    this.nextDubbedStart = 0;

    this.report('starting');
    this.connect();
  }

  stop(): void {
    this.stopInternal();
    this.report('idle');
  }

  applyVolumes(originalVolume: number, dubbedVolume: number): void {
    // Smooth gain changes avoid clicks when the user drags the sliders.
    if (this.originalGain && this.captureCtx) {
      this.originalGain.gain.setTargetAtTime(originalVolume, this.captureCtx.currentTime, 0.05);
    }
    if (this.dubbedGain && this.captureCtx) {
      this.dubbedGain.gain.setTargetAtTime(dubbedVolume, this.captureCtx.currentTime, 0.05);
    }
  }

  private onPcmChunk(event: MessageEvent): void {
    if (!isProcessorMessage(event) || this.stopped) return;
    if (!this.setupComplete || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.droppedWhileDown += 1;
      return;
    }
    const samples = new Int16Array(event.data.pcm);
    if (samples.length === 0) return;
    this.ws.send(buildAudioMessage(encodeInt16ToBase64(samples)));
    this.chunksSent += 1;
    if (this.chunksSent % 50 === 0) {
      console.debug(
        `[doubling] sent ${this.chunksSent} chunks, received ${this.audioChunksReceived} audio chunks`,
      );
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.setupComplete = false;
    const ws = new WebSocket(buildLiveEndpoint(this.apiKey));
    this.ws = ws;
    let lastCloseReason = '';

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      ws.send(buildSetupMessage(this.targetLanguage));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || this.stopped) return;
      void (async () => {
        const msg = await parseServerMessage(event.data);
        if (!msg || this.ws !== ws || this.stopped) return;
        const serverError = extractErrorText(msg);
        if (serverError) {
          this.fail(new Error(`Gemini: ${serverError}`));
          return;
        }
        if (isSetupCompleteMessage(msg)) {
          this.setupComplete = true;
          this.reconnectAttempts = 0;
          this.report('live');
          return;
        }
        const audio = extractOutputAudioBase64(msg);
        if (audio) {
          this.audioChunksReceived += 1;
          if (this.audioChunksReceived === 1) console.debug('[doubling] first dubbed audio chunk');
          this.playDubbedChunk(decodeBase64ToInt16(audio));
        }
      })();
    };

    ws.onerror = () => {
      // onclose follows and owns the reconnect decision.
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws || this.stopped) return;
      lastCloseReason =
        event.reason ||
        (event.code === 1006
          ? 'abnormal close (often bad key, blocked network, or rejected setup)'
          : `code ${event.code}`);
      this.ws = null;
      this.setupComplete = false;
      this.scheduleReconnect(lastCloseReason);
    };
  }

  private scheduleReconnect(closeReason = ''): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const detail = closeReason ? ` Last close: ${closeReason}.` : '';
      this.fail(
        new Error(
          `Lost the Gemini connection (${this.droppedWhileDown} chunks dropped).${detail} Check the key and network, then Start again.`,
        ),
      );
      return;
    }
    this.reconnectAttempts += 1;
    this.report('starting', `Reconnecting (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
    this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  private playDubbedChunk(samples: Int16Array): void {
    if (!this.captureCtx || !this.dubbedGain || samples.length === 0) return;
    const ctx = this.captureCtx;
    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE_HZ);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.dubbedGain);
    const startAt = Math.max(ctx.currentTime + 0.02, this.nextDubbedStart);
    source.start(startAt);
    this.nextDubbedStart = startAt + buffer.duration;
  }

  private fail(err: Error): void {
    this.stopInternal();
    this.report('error', err.message);
  }

  private stopInternal(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closed.
      }
      this.ws = null;
    }
    this.setupComplete = false;
    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      this.captureNode.disconnect();
      this.captureNode = null;
    }
    if (this.keepAliveGain) {
      this.keepAliveGain.disconnect();
      this.keepAliveGain = null;
    }
    if (this.originalGain) {
      this.originalGain.disconnect();
      this.originalGain = null;
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((track) => track.stop());
      this.captureStream = null;
    }
    if (this.dubbedGain) {
      this.dubbedGain.disconnect();
      this.dubbedGain = null;
    }
    if (this.captureCtx) {
      void this.captureCtx.close().catch(() => undefined);
      this.captureCtx = null;
    }
    this.nextDubbedStart = 0;
  }

  /** Public so the message listener can surface async start failures. */
  report(status: SessionStatus, error?: string): void {
    const message: OffscreenStatusMessage = { kind: 'OFFSCREEN_STATUS', status, error };
    // Fire-and-forget: the service worker persists this for the popup.
    chrome.runtime.sendMessage(message).catch(() => undefined);
  }
}

const engine = new DubEngine();

chrome.runtime.onMessage.addListener((message) => {
  const msg = message as SwToOffscreenMessage;
  if (msg.kind === 'OFFSCREEN_START') {
    // NOTE: intentionally no `return true` / sendResponse here. The service
    // worker already moved on; status flows back via OFFSCREEN_STATUS.
    engine
      .start({
        streamId: msg.streamId,
        targetLanguage: msg.targetLanguage,
        apiKey: msg.apiKey,
        originalVolume: msg.originalVolume,
        dubbedVolume: msg.dubbedVolume,
      })
      .catch((err: unknown) =>
        engine.report('error', err instanceof Error ? err.message : String(err)),
      );
  } else if (msg.kind === 'OFFSCREEN_STOP') {
    engine.stop();
  } else if (msg.kind === 'OFFSCREEN_UPDATE_VOLUMES') {
    engine.applyVolumes(msg.originalVolume, msg.dubbedVolume);
  }
  return false;
});
