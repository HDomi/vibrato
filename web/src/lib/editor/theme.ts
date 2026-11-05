import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * Syntax colors from Community Material Theme — Darker High Contrast (Equinusocio.vsc-community-material-theme
 * 1.4.6, Apache-2.0), ported to CodeMirror. The surfaces (backgrounds, borders, gutter, selection) use the
 * app's own navy palette instead of the theme's grays, so IDE mode matches the rest of the window.
 */
export const M = {
  /** Same as the page background (index.css) and the chat area. */
  bg: '#0b0d12',
  /** Same as the VIBE sidebar and the title bar. */
  sidebar: '#0e1117',
  fg: '#EEFFFF',
  dim: '#8b92a1',
  faint: '#5d6575',
  lineNumber: '#3a4150',
  border: '#ffffff1a',
  accent: '#80CBC4',
  cursor: '#FFCC00',
  selection: '#7aa2f733',
  input: '#171a22',
  comment: '#545d6e',
  purple: '#C792EA',
  cyan: '#89DDFF',
  green: '#C3E88D',
  blue: '#82AAFF',
  yellow: '#FFCB6B',
  orange: '#F78C6C',
  red: '#FF5370',
  pink: '#f07178',
  slate: '#B2CCD6',
} as const;

const chrome = EditorView.theme({
  '&': { color: M.fg, backgroundColor: M.bg, height: '100%', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "Pretendard Variable", monospace', lineHeight: '1.55' },
  '.cm-content': { caretColor: M.cursor, padding: '4px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: M.cursor, borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: M.selection },
  '.cm-activeLine': { backgroundColor: '#ffffff08' },
  '.cm-selectionMatch': { backgroundColor: '#FFCC0020' },
  '.cm-searchMatch': { backgroundColor: '#ffffff10', outline: '1px solid #ffffff50' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#ffffff1a', outline: `1px solid ${M.accent}` },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: M.bg, outline: '1px solid #FFCC0050' },
  '&.cm-focused .cm-nonmatchingBracket': { outline: `1px solid ${M.red}70` },
  '.cm-gutters': { backgroundColor: M.bg, color: M.lineNumber, border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', minWidth: '28px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: M.dim },
  '.cm-foldGutter .cm-gutterElement': { color: M.faint, padding: '0 4px' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: `1px solid ${M.lineNumber}`, color: M.dim },
  '.cm-tooltip': { backgroundColor: M.input, border: '1px solid #FFFFFF10', color: M.fg },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#7aa2f733', color: M.fg },
  '.cm-completionMatchedText': { color: M.accent, textDecoration: 'none' },
  '.cm-panels': { backgroundColor: M.sidebar, color: M.fg },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${M.border}` },
  '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${M.border}` },
  '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '12px' },
  '.cm-panel.cm-search label': { color: M.dim, fontSize: '11px' },
  '.cm-textfield': { backgroundColor: M.input, border: '1px solid #FFFFFF10', borderRadius: '4px', color: M.fg, padding: '2px 6px', fontSize: '12px' },
  '.cm-textfield:focus': { outline: `1px solid ${M.accent}` },
  '.cm-button': { backgroundImage: 'none', backgroundColor: '#ffffff14', border: 'none', borderRadius: '4px', color: M.fg, fontSize: '11px', padding: '2px 8px' },
  '.cm-panel button[name=close]': { color: M.dim },
  '.cm-specialChar': { color: M.red },
  '.cm-trailingSpace': { backgroundColor: '#FF537030' },
}, { dark: true });

const syntax = HighlightStyle.define([
  { tag: t.comment, color: M.comment, fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier, t.definitionKeyword, t.moduleKeyword], color: M.purple },
  { tag: t.self, color: M.red, fontStyle: 'italic' },
  { tag: [t.controlKeyword, t.operatorKeyword], color: M.cyan, fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket, t.derefOperator], color: M.cyan },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.inserted, t.heading], color: M.green },
  { tag: [t.regexp, t.escape, t.url], color: M.cyan },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: M.orange },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: M.pink },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: M.blue },
  { tag: [t.typeName, t.className, t.namespace, t.labelName], color: M.yellow },
  { tag: t.standard(t.typeName), color: M.slate },
  { tag: t.tagName, color: M.pink },
  { tag: t.attributeName, color: M.purple, fontStyle: 'italic' },
  { tag: t.attributeValue, color: M.green },
  { tag: t.propertyName, color: M.slate },
  { tag: t.definition(t.propertyName), color: M.pink },
  { tag: [t.variableName, t.definition(t.variableName), t.content], color: M.fg },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: M.blue, fontStyle: 'italic' },
  { tag: t.deleted, color: M.red },
  { tag: t.changed, color: M.purple },
  { tag: t.invalid, color: M.red },
  { tag: t.link, color: M.blue },
  { tag: t.emphasis, color: M.pink, fontStyle: 'italic' },
  { tag: t.strong, color: M.pink, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, color: M.purple },
  { tag: t.quote, color: '#65737E', fontStyle: 'italic' },
]);

export const materialTheme = [chrome, syntaxHighlighting(syntax)];
