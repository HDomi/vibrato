/** UI text of this platform that differs from the shared dictionary (lib/i18n.ts): none, the dictionary is written for macOS. */
export const STRINGS: Record<'en' | 'ko', Record<string, string>> = { en: {}, ko: {} };

/** Shortcut labels as this platform writes them: the dictionary already uses the Mac symbols (⌘, ⌥, ⇧). */
export const keyLabel = (s: string): string => s;

/** One argument for a terminal tab's shell (zsh): single-quoted, so nothing in it is expanded or run. */
export const quoteShellArg = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
