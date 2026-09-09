// Shared message + storage types for popup <-> service worker <-> offscreen.

export type SessionStatus = 'idle' | 'starting' | 'live' | 'stopping' | 'error';

export interface SessionState {
  status: SessionStatus;
  targetLanguage?: string;
  tabId?: number;
  startedAt?: number;
  error?: string;
}

export interface DubSettings {
  /** Gemini API key. Stored only in chrome.storage.local, never sent anywhere except Google. */
  apiKey: string;
  /** BCP-47 target language code, e.g. "es". */
  targetLanguage: string;
  /** 0..1 gain for the original tab audio passthrough. */
  originalVolume: number;
  /** 0..1 gain for the dubbed voice. */
  dubbedVolume: number;
}

export const SESSION_STORAGE_KEY = 'doubling.session';
export const SETTINGS_STORAGE_KEY = 'doubling.settings';

/** Path of the offscreen document, relative to the extension root. */
export const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// Popup -> service worker
export type PopupToSwMessage =
  | { kind: 'START_DUBBING' }
  | { kind: 'STOP_DUBBING' }
  | { kind: 'UPDATE_VOLUMES'; originalVolume: number; dubbedVolume: number };

// Service worker -> offscreen document
export type OffscreenStartMessage = {
  kind: 'OFFSCREEN_START';
  /** One-time stream id from chrome.tabCapture.getMediaStreamId(). Expires in seconds. */
  streamId: string;
  targetTabId: number;
  targetLanguage: string;
  /** Passed from the SW — offscreen docs may not expose chrome.storage. */
  apiKey: string;
  originalVolume: number;
  dubbedVolume: number;
};

export type OffscreenStopMessage = { kind: 'OFFSCREEN_STOP' };

export type OffscreenVolumesMessage = {
  kind: 'OFFSCREEN_UPDATE_VOLUMES';
  originalVolume: number;
  dubbedVolume: number;
};

export type SwToOffscreenMessage =
  | OffscreenStartMessage
  | OffscreenStopMessage
  | OffscreenVolumesMessage;

// Offscreen document -> service worker (persisted to storage for the popup)
export interface OffscreenStatusMessage {
  kind: 'OFFSCREEN_STATUS';
  status: SessionStatus;
  error?: string;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
