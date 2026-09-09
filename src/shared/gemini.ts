// Helpers for the Gemini Live Translate WebSocket session.
// Audio contract (public docs): 16-bit 16 kHz mono PCM in (~100 ms chunks),
// 24 kHz mono PCM out. The model id below is a preview name — if Google
// renames it, update LIVE_TRANSLATE_MODEL and the setup payload shape.

export const LIVE_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';

export const INPUT_SAMPLE_RATE_HZ = 16000;
export const OUTPUT_SAMPLE_RATE_HZ = 24000;
/** Recommended streaming chunk size. */
export const CHUNK_MS = 100;
export const SAMPLES_PER_CHUNK = (INPUT_SAMPLE_RATE_HZ * CHUNK_MS) / 100; // 1600

export function buildLiveEndpoint(apiKey: string): string {
  const base =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  return `${base}?key=${encodeURIComponent(apiKey)}`;
}

export function buildSetupMessage(targetLanguage: string): string {
  // Per the Live API reference (BidiGenerateContentSetup): translationConfig
  // belongs inside generationConfig. Audio transcription fields are top-level
  // setup fields — omitted here because the MVP is audio-only.
  return JSON.stringify({
    setup: {
      model: LIVE_TRANSLATE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: targetLanguage,
          echoTargetLanguage: false,
        },
      },
    },
  });
}

export function buildAudioMessage(base64Pcm16k: string): string {
  return JSON.stringify({
    realtimeInput: {
      audio: { mimeType: 'audio/pcm;rate=16000', data: base64Pcm16k },
    },
  });
}

export function isSetupCompleteMessage(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'setupComplete' in msg;
}

/** Walks serverContent.modelTurn.parts[] and returns the first inline audio payload, if any. */
export function extractOutputAudioBase64(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const content = (msg as { serverContent?: { modelTurn?: { parts?: unknown } } })
    .serverContent;
  const parts = content?.modelTurn?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const data = (part as { inlineData?: { data?: unknown } })?.inlineData?.data;
    if (typeof data === 'string' && data.length > 0) return data;
  }
  return null;
}

/** Surfaces a server-side { error: { message } } frame as text, if present. */
export function extractErrorText(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const err = (msg as { error?: { message?: unknown; status?: unknown; code?: unknown } }).error;
  if (!err || typeof err !== 'object') return null;
  const message = typeof err.message === 'string' ? err.message : '';
  if (!message) return null;
  const status = typeof err.status === 'string' ? ` (${err.status})` : '';
  return `${message}${status}`;
}

/**
 * Gemini Live often delivers JSON as a Blob (or ArrayBuffer). Decode first,
 * otherwise JSON.parse silently fails and setupComplete is never seen.
 */
export async function parseServerMessage(data: unknown): Promise<unknown | null> {
  try {
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof Blob) {
      text = await data.text();
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data);
    } else {
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function encodeInt16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export function decodeBase64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const aligned = bytes.length - (bytes.length % 2);
  return new Int16Array(bytes.buffer, bytes.byteOffset, aligned / 2);
}
