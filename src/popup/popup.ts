// Popup UI: key + language + volumes, Start/Stop, live session status.
// The popup is deliberately thin: capture + Gemini streaming live in the
// offscreen document, coordinated by the service worker.
import {
  SESSION_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  messageOf,
  type DubSettings,
  type PopupToSwMessage,
  type SessionState,
  type SessionStatus,
} from '../shared/messages.js';
import { DEFAULT_LANGUAGE, TARGET_LANGUAGES } from '../shared/languages.js';

const apiKeyEl = document.getElementById('apiKey') as HTMLInputElement;
const toggleKeyEl = document.getElementById('toggleKey') as HTMLButtonElement;
const languageEl = document.getElementById('language') as HTMLSelectElement;
const originalVolumeEl = document.getElementById('originalVolume') as HTMLInputElement;
const dubbedVolumeEl = document.getElementById('dubbedVolume') as HTMLInputElement;
const originalVolumeLabel = document.getElementById('originalVolumeLabel') as HTMLElement;
const dubbedVolumeLabel = document.getElementById('dubbedVolumeLabel') as HTMLElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;

const STATUS_TEXT: Record<SessionStatus, string> = {
  idle: 'Idle.',
  starting: 'Starting… capturing the tab and connecting to Gemini.',
  live: 'Live — you should hear the dubbed voice.',
  stopping: 'Stopping…',
  error: 'Something went wrong.',
};

for (const lang of TARGET_LANGUAGES) {
  const option = document.createElement('option');
  option.value = lang.code;
  option.textContent = lang.label;
  languageEl.appendChild(option);
}

async function loadSettings(): Promise<DubSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const saved = stored[SETTINGS_STORAGE_KEY] as Partial<DubSettings> | undefined;
  return {
    apiKey: saved?.apiKey ?? '',
    targetLanguage: saved?.targetLanguage ?? DEFAULT_LANGUAGE,
    originalVolume: saved?.originalVolume ?? 0.25,
    dubbedVolume: saved?.dubbedVolume ?? 1,
  };
}

async function loadSession(): Promise<SessionState> {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  return (stored[SESSION_STORAGE_KEY] as SessionState | undefined) ?? { status: 'idle' };
}

function readForm(): DubSettings {
  return {
    apiKey: apiKeyEl.value.trim(),
    targetLanguage: languageEl.value || DEFAULT_LANGUAGE,
    originalVolume: Number(originalVolumeEl.value) / 100,
    dubbedVolume: Number(dubbedVolumeEl.value) / 100,
  };
}

function paintVolumeLabels(): void {
  originalVolumeLabel.textContent = `${originalVolumeEl.value}%`;
  dubbedVolumeLabel.textContent = `${dubbedVolumeEl.value}%`;
}

function showError(text: string): void {
  errorEl.textContent = text;
  errorEl.hidden = false;
}

function clearError(): void {
  errorEl.textContent = '';
  errorEl.hidden = true;
}

function render(session: SessionState): void {
  const running = session.status === 'starting' || session.status === 'live';
  startBtn.hidden = running;
  stopBtn.hidden = !running;
  startBtn.disabled = session.status === 'starting' || session.status === 'stopping';
  statusEl.textContent = STATUS_TEXT[session.status];
  if (session.status === 'error') showError(session.error ?? 'Unknown error.');
  else if (!running) clearError();
}

async function refresh(): Promise<void> {
  render(await loadSession());
}

toggleKeyEl.addEventListener('click', () => {
  const show = apiKeyEl.type === 'password';
  apiKeyEl.type = show ? 'text' : 'password';
  toggleKeyEl.textContent = show ? 'Hide' : 'Show';
});

languageEl.addEventListener('change', () => {
  void chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: readForm() });
});

function persistAndPushVolumes(): void {
  paintVolumeLabels();
  const settings = readForm();
  void chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  // Offscreen may not have chrome.storage — push volumes over messaging.
  void chrome.runtime
    .sendMessage({
      kind: 'UPDATE_VOLUMES',
      originalVolume: settings.originalVolume,
      dubbedVolume: settings.dubbedVolume,
    } satisfies PopupToSwMessage)
    .catch(() => undefined);
}

originalVolumeEl.addEventListener('input', persistAndPushVolumes);
dubbedVolumeEl.addEventListener('input', persistAndPushVolumes);
originalVolumeEl.addEventListener('change', persistAndPushVolumes);
dubbedVolumeEl.addEventListener('change', persistAndPushVolumes);

startBtn.addEventListener('click', () => {
  void (async () => {
    clearError();
    const settings = readForm();
    if (!settings.apiKey) {
      showError('Paste your Gemini API key first. It stays on this device.');
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
      showError('Open a normal website tab (not a chrome:// page) and try again.');
      return;
    }
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
    startBtn.disabled = true;
    try {
      const res = (await chrome.runtime.sendMessage({
        kind: 'START_DUBBING',
      } satisfies PopupToSwMessage)) as { ok: boolean; error?: string };
      if (!res?.ok) showError(res?.error ?? 'Could not start dubbing.');
    } catch (err) {
      showError(messageOf(err));
    } finally {
      await refresh();
    }
  })();
});

stopBtn.addEventListener('click', () => {
  void (async () => {
    clearError();
    try {
      await chrome.runtime.sendMessage({ kind: 'STOP_DUBBING' } satisfies PopupToSwMessage);
    } catch (err) {
      showError(messageOf(err));
    } finally {
      await refresh();
    }
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SESSION_STORAGE_KEY]?.newValue) {
    render(changes[SESSION_STORAGE_KEY].newValue as SessionState);
  }
});

void (async () => {
  const settings = await loadSettings();
  apiKeyEl.value = settings.apiKey;
  languageEl.value = settings.targetLanguage;
  originalVolumeEl.value = String(Math.round(settings.originalVolume * 100));
  dubbedVolumeEl.value = String(Math.round(settings.dubbedVolume * 100));
  paintVolumeLabels();
  await refresh();
})();
