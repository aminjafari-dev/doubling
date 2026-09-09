# Doubling — Live Tab Dubbing (MVP)

Audio-only Chrome extension prototype: captures the active tab, streams it to
Gemini Live Translate with **your own API key**, and plays the dubbed voice back.
TypeScript, Manifest V3, no backend, no accounts.

## How it works

```
popup (key, language, Start/Stop)
  -> service worker (session state, tabCapture stream id)
    -> offscreen document (tab audio -> 16 kHz PCM -> Gemini Live Translate
       -> 24 kHz dubbed voice + original passthrough mix)
```

Key detail: capturing a tab mutes it for the speakers, so the offscreen page
plays the original audio back itself under the dubbed track (there is an
"Original volume" slider for that).

## Prerequisites

- Chrome 116+
- A free Gemini API key from Google AI Studio (https://aistudio.google.com/).
  Gemini usage bills to that key; the key stays in `chrome.storage.local`.

## Build

```sh
npm install
npm run build   # typechecks, emits dist/, copies manifest + html/css/worklet
```

To load it in Chrome: `chrome://extensions` → Developer mode → Load unpacked →
select the `dist/` folder.

## Use

1. Open a normal website tab (`https://…`) that is playing sound.
2. Click the Doubling icon, paste the Gemini key, pick a language.
3. Press Start. Status goes starting → live; the original keeps playing softly
   under the dubbed voice.
4. Press Stop, or close the tab, to end the session.

## Troubleshooting

- `chrome://` pages and the Web Store cannot be captured — open a real site.
- Silent tabs fail fast: "That tab is not producing any audio."
- Drops reconnect up to 5 times, then surface the error in the popup.
- `gemini-3.5-live-translate-preview` is a preview model id; if Google renames
  it or moves `translationConfig`, update `src/shared/gemini.ts`.

## Privacy

Local-only prototype: the API key and settings never leave the device except
for the direct WebSocket to Google under your key. No telemetry, no backend.
