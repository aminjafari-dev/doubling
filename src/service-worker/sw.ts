// Service worker: owns session state, mints the tab-capture stream id, and
// forwards it to the offscreen document. It never touches raw audio — the
// service worker has no DOM, so media must live in the offscreen document.
import {
  OFFSCREEN_DOCUMENT_PATH,
  SESSION_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  messageOf,
  type DubSettings,
  type OffscreenStatusMessage,
  type PopupToSwMessage,
  type SessionState,
  type SwToOffscreenMessage,
} from '../shared/messages.js';
import { DEFAULT_LANGUAGE } from '../shared/languages.js';

async function getSession(): Promise<SessionState> {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  return (stored[SESSION_STORAGE_KEY] as SessionState | undefined) ?? { status: 'idle' };
}

async function setSession(patch: Partial<SessionState>): Promise<SessionState> {
  const next: SessionState = { ...(await getSession()), ...patch };
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: next });
  return next;
}

async function getSettings(): Promise<DubSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const saved = stored[SETTINGS_STORAGE_KEY] as Partial<DubSettings> | undefined;
  return {
    apiKey: saved?.apiKey ?? '',
    targetLanguage: saved?.targetLanguage ?? DEFAULT_LANGUAGE,
    originalVolume: saved?.originalVolume ?? 0.25,
    dubbedVolume: saved?.dubbedVolume ?? 1,
  };
}

async function ensureOffscreenDocument(): Promise<void> {
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Capture tab audio and stream it to Gemini Live Translate for live dubbing.',
    });
  } catch (err) {
    // A second create call races the getContexts check; that is harmless.
    if (!messageOf(err).includes('single offscreen')) throw err;
  }
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed — nothing to do.
  }
}

async function handleStart(): Promise<void> {
  const current = await getSession();
  if (current.status === 'starting' || current.status === 'live') return;

  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No Gemini API key saved. Paste it in the popup first.');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab found.');
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error('Chrome can only capture normal website tabs, not chrome:// pages.');
  }

  await setSession({
    status: 'starting',
    targetLanguage: settings.targetLanguage,
    tabId: tab.id,
    startedAt: Date.now(),
    error: undefined,
  });

  try {
    await ensureOffscreenDocument();
    // One-time stream id; the offscreen document must redeem it within seconds.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    // Fire-and-forget: the offscreen listener starts async work without
    // holding a sendResponse channel, and reports back via OFFSCREEN_STATUS.
    await chrome.runtime.sendMessage({
      kind: 'OFFSCREEN_START',
      streamId,
      targetTabId: tab.id,
      targetLanguage: settings.targetLanguage,
      apiKey: settings.apiKey,
      originalVolume: settings.originalVolume,
      dubbedVolume: settings.dubbedVolume,
    } satisfies SwToOffscreenMessage);
  } catch (err) {
    await closeOffscreenDocument();
    await setSession({ status: 'error', error: messageOf(err) });
    throw err;
  }
}

async function handleStop(): Promise<void> {
  await setSession({ status: 'stopping' });
  try {
    await chrome.runtime.sendMessage({ kind: 'OFFSCREEN_STOP' } satisfies SwToOffscreenMessage);
  } catch {
    // No receiver (offscreen already gone) — safe to ignore.
  }
  await closeOffscreenDocument();
  const session = await getSession();
  await setSession({ status: 'idle', error: undefined, startedAt: undefined, tabId: undefined });
  void session;
}

// If the dubbed tab is closed, tear the session down instead of idling.
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const session = await getSession();
    if (session.tabId === tabId && (session.status === 'live' || session.status === 'starting')) {
      await handleStop();
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const kind = (message as { kind?: string })?.kind;

  if (kind === 'START_DUBBING') {
    handleStart()
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: messageOf(err) }));
    return true; // async sendResponse
  }

  if (kind === 'STOP_DUBBING') {
    handleStop()
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: messageOf(err) }));
    return true;
  }

  if (kind === 'UPDATE_VOLUMES') {
    const msg = message as Extract<PopupToSwMessage, { kind: 'UPDATE_VOLUMES' }>;
    void (async () => {
      const settings = await getSettings();
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: {
          ...settings,
          originalVolume: msg.originalVolume,
          dubbedVolume: msg.dubbedVolume,
        },
      });
      try {
        await chrome.runtime.sendMessage({
          kind: 'OFFSCREEN_UPDATE_VOLUMES',
          originalVolume: msg.originalVolume,
          dubbedVolume: msg.dubbedVolume,
        } satisfies SwToOffscreenMessage);
      } catch {
        // Offscreen not running — volumes are still saved for the next Start.
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (kind === 'OFFSCREEN_STATUS') {
    const status = message as OffscreenStatusMessage;
    void setSession({
      status: status.status,
      error: status.error,
    });
    return false;
  }

  // Unknown message kinds (e.g. offscreen-only) — ignore.
  void _sender;
  return false;
});
