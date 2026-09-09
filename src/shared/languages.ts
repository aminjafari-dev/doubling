// Small starter list of dubbing target languages (BCP-47 codes).
// Gemini Live Translate supports 70+; grow this list once the MVP works.

export interface TargetLanguage {
  code: string;
  label: string;
}

export const TARGET_LANGUAGES: TargetLanguage[] = [
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French (Français)' },
  { code: 'de', label: 'German (Deutsch)' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'it', label: 'Italian (Italiano)' },
  { code: 'nl', label: 'Dutch (Nederlands)' },
  { code: 'pl', label: 'Polish (Polski)' },
  { code: 'ja', label: 'Japanese (日本語)' },
  { code: 'fa', label: 'Persian (فارسی)' },
];

export const DEFAULT_LANGUAGE = 'es';

export function isSupportedLanguage(code: string): boolean {
  return TARGET_LANGUAGES.some((lang) => lang.code === code);
}
