/**
 * Scripts injected into the in-app browser's WKWebView pages (see browser.cts).
 *
 * PAGE_HOOKS runs in the page's own world: it wraps console, fetch and XHR and watches resource timings, then
 * hands each record to the isolated world through a private DOM event. RELAY runs in the isolated "vibrato"
 * world, the only place the native message handler exists, so pages never see a Vibrato bridge. Google
 * sign-in pages get no hooks at all.
 *
 * AGENT_HELPERS (isolated world) backs the agent tools: an accessibility-style snapshot with element refs,
 * ref/selector lookup and element geometry. Refs live in a WeakMap of that world and never touch the DOM.
 */

export const PAGE_HOOKS = String.raw`(() => {
  if (/(^|\.)accounts\.google\.com$/.test(location.hostname) || window.__vbHooked) return;
  Object.defineProperty(window, '__vbHooked', { value: true });
  const send = (kind, data) => { try { document.dispatchEvent(new CustomEvent('__vb_hook', { detail: JSON.stringify({ kind, t: Date.now(), frame: window === top ? '' : location.href, ...data }) })); } catch {} };
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || String(a);
    if (a instanceof Element) return '<' + a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + '>';
    try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch { return String(a); }
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) { send('console', { level, text: args.map(fmt).join(' ').slice(0, 20000) }); return orig.apply(this, args); };
  }
  addEventListener('error', (e) => { if (e.error || e.message) send('console', { level: 'error', text: (e.error && e.error.stack) || e.message, source: e.filename ? e.filename + ':' + e.lineno : '' }); });
  addEventListener('unhandledrejection', (e) => send('console', { level: 'error', text: 'Unhandled rejection: ' + fmt(e.reason) }));
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const origFetch = window.fetch;
  if (origFetch) window.fetch = async function (input, init) {
    const url = abs(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const t0 = performance.now();
    try {
      const r = await origFetch.apply(this, arguments);
      send('net', { via: 'fetch', method, url: r.url || url, status: r.status, type: r.headers.get('content-type') || '', ms: Math.round(performance.now() - t0) });
      return r;
    } catch (e) { send('net', { via: 'fetch', method, url, error: String(e && e.message || e), ms: Math.round(performance.now() - t0) }); throw e; }
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__vb = { method: String(method).toUpperCase(), url: abs(url) }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__vb; const t0 = performance.now();
    if (info) this.addEventListener('loadend', () => send('net', { via: 'xhr', method: info.method, url: this.responseURL || info.url, status: this.status, type: this.getResponseHeader('content-type') || '', error: this.status === 0 ? 'failed' : undefined, ms: Math.round(performance.now() - t0) }));
    return XS.apply(this, arguments);
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') continue;
        send('net', { via: e.initiatorType || 'resource', method: 'GET', url: e.name, status: e.responseStatus || undefined, size: e.transferSize || undefined, ms: Math.round(e.duration) });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {}
})();`;

export const RELAY = String.raw`document.addEventListener('__vb_hook', (e) => { try { webkit.messageHandlers.vibrato.postMessage(JSON.parse(e.detail)); } catch {} });`;

/** Defines globalThis.__vb in the isolated world (idempotent). Prepended to every agent evaluation. */
export const AGENT_HELPERS = String.raw`
if (!globalThis.__vb) {
  const byEl = new WeakMap(); const byRef = new Map(); let n = 0;
  const refOf = (el) => { let r = byEl.get(el); if (!r) { r = 'e' + (++n); byEl.set(el, r); byRef.set(r, new WeakRef(el)); } return r; };
  const IMPLICIT = { A: (el) => el.hasAttribute('href') ? 'link' : '', BUTTON: () => 'button', SELECT: (el) => el.multiple ? 'listbox' : 'combobox', TEXTAREA: () => 'textbox',
    IMG: (el) => el.getAttribute('alt') === '' ? '' : 'img', H1: () => 'heading', H2: () => 'heading', H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    NAV: () => 'navigation', MAIN: () => 'main', HEADER: () => 'banner', FOOTER: () => 'contentinfo', ASIDE: () => 'complementary', FORM: () => 'form', DIALOG: () => 'dialog',
    UL: () => 'list', OL: () => 'list', LI: () => 'listitem', TABLE: () => 'table', TR: () => 'row', TD: () => 'cell', TH: () => 'columnheader', OPTION: () => 'option',
    P: () => 'paragraph', LABEL: () => 'label', SUMMARY: () => 'button', PROGRESS: () => 'progressbar',
    INPUT: (el) => ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', hidden: '', file: 'button' })[el.type] ?? 'textbox' };
  const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'option', 'tab', 'menuitem', 'switch', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r.split(' ')[0]; if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox'; const f = IMPLICIT[el.tagName]; return f ? f(el) : ''; };
  const clip = (s, n = 100) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const nameOf = (el, role) => {
    const al = el.getAttribute('aria-label'); if (al) return clip(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' '); if (t.trim()) return clip(t); }
    if (el.tagName === 'IMG') return clip(el.getAttribute('alt') || el.getAttribute('title'));
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.labels && el.labels[0]) return clip(el.labels[0].textContent);
      if (['button', 'submit', 'reset'].includes(el.type)) return clip(el.value || el.type);
      return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
    }
    if (['link', 'button', 'heading', 'tab', 'menuitem', 'option', 'cell', 'columnheader', 'label', 'listitem', 'treeitem', 'switch', 'checkbox', 'radio'].includes(role)) return clip(el.innerText || el.textContent);
    return clip(el.getAttribute('title'));
  };
  const hidden = (el) => {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    return false;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'SVG', 'PATH']);
  const snapshot = (root, maxDepth = 40, maxLines = 3000) => {
    const lines = [];
    const push = (depth, s) => { if (lines.length < maxLines) lines.push('  '.repeat(depth) + '- ' + s); };
    const walk = (node, depth, inInteractive) => {
      if (lines.length >= maxLines || depth > maxDepth) return;
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { const t = clip(child.textContent, 160); if (t && !inInteractive) push(depth, 'text: ' + JSON.stringify(t)); continue; }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (SKIP.has(el.tagName.toUpperCase()) || hidden(el)) continue;
        const role = roleOf(el);
        const clickable = !role && !inInteractive && getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
        if (el.tagName === 'IFRAME') {
          let doc = null; try { doc = el.contentDocument; } catch {}
          push(depth, 'iframe ' + JSON.stringify(el.src || '') + ' [ref=' + refOf(el) + ']' + (doc ? '' : ' (cross-origin)'));
          if (doc && doc.body) walk(doc.body, depth + 1, false);
          continue;
        }
        if (role || clickable) {
          const r = role || 'generic';
          const name = nameOf(el, r);
          const interactive = INTERACTIVE.has(r) || clickable;
          let line = r + (name ? ' ' + JSON.stringify(name) : '');
          if (r === 'heading') line += ' [level=' + (Number(el.getAttribute('aria-level')) || Number(el.tagName[1]) || 2) + ']';
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]';
          if (el.checked || el.getAttribute('aria-checked') === 'true') line += ' [checked]';
          if (el.getAttribute('aria-expanded')) line += ' [expanded=' + el.getAttribute('aria-expanded') + ']';
          if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) line += ' [selected]';
          if (clickable) line += ' [clickable]';
          if (interactive || el.tagName === 'IMG') line += ' [ref=' + refOf(el) + ']';
          if ((r === 'textbox' || r === 'searchbox' || r === 'spinbutton' || r === 'combobox') && 'value' in el && el.value) line += ': ' + JSON.stringify(clip(String(el.value), 120));
          if (r === 'link' && el.getAttribute('href')) line += ' -> ' + clip(el.getAttribute('href'), 120);
          push(depth, line);
          if (!['textbox', 'searchbox', 'img', 'combobox', 'listbox', 'slider', 'spinbutton', 'progressbar'].includes(r) || el.tagName === 'SELECT') walk(el.shadowRoot || el, depth + 1, inInteractive || interactive);
        } else {
          walk(el.shadowRoot || el, depth, inInteractive);
        }
      }
    };
    walk(root, 0, false);
    if (lines.length >= maxLines) lines.push('- … (truncated; pass a selector to narrow the snapshot)');
    return lines.join('\n');
  };
  const find = (target) => {
    if (!target) throw new Error('ref or selector required');
    if (/^e\d+$/.test(target)) { const el = byRef.get(target)?.deref(); if (!el || !el.isConnected) throw new Error('ref ' + target + ' is stale; take a new snapshot'); return el; }
    const el = document.querySelector(target); if (!el) throw new Error('no element matches ' + target); return el;
  };
  const center = async (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 60)); // not rAF: it pauses while the window is covered
    let r = el.getBoundingClientRect(); let x = r.left + r.width / 2, y = r.top + r.height / 2;
    // Map coordinates out of same-origin iframes into the top document.
    let w = el.ownerDocument.defaultView;
    while (w && w !== top && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
    if (r.width === 0 && r.height === 0) throw new Error('element has no size (hidden?)');
    const hit = document.elementFromPoint(x, y);
    const covered = hit && hit !== el && !el.contains(hit) && !(hit.tagName === 'IFRAME');
    return { x, y, w: r.width, h: r.height, covered: covered ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.') : '')) : null };
  };
  globalThis.__vb = { snapshot, find, center, refOf };
}
`;

/** Cookie `domain` (leading dot = subdomains too) matches the page host the way browsers send it. */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return !!d && (h === d || h.endsWith(`.${d}`));
}
