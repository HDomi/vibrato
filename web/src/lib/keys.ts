const CODE_KEYS: Record<string, string> = {
  Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
};

/**
 * The lowercase key a ⌘/Ctrl shortcut means. With a Korean (or other non-Latin) input source `e.key` is the
 * composed character (⌘P arrives as "ㅔ"), and ⌥ turns letters into symbols ("ß"); then the physical key
 * decides. An ASCII `e.key` is kept, so Latin layouts like Dvorak still match by the letter they type.
 */
export function shortcutKey(e: { key: string; code: string }): string {
  const k = e.key;
  if (k.length === 1 && k.charCodeAt(0) < 128) return k.toLowerCase();
  const c = e.code ?? '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  return CODE_KEYS[c] ?? k.toLowerCase();
}
