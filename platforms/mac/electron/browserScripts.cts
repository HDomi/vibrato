/**
 * Scripts injected into the in-app browser's WKWebView pages (see browser.cts).
 *
 * pageHooks() runs in the page's own world: it wraps console, fetch and XHR (recording request/response bodies and
 * answering mocked requests) and watches resource timings, then hands each record to the isolated world through a
 * private DOM event. RELAY runs in the isolated "vibrato" world, the only place the native message handler exists,
 * so pages never see a Vibrato bridge. Google sign-in pages get no hooks at all.
 *
 * AGENT_HELPERS (isolated world) backs the agent tools: snapshots with element refs, ref/selector lookup,
 * actionability checks, element state, Playwright locators, measurements and the element picker. Refs live in a
 * WeakMap of that world and never touch the DOM.
 */

/** A mocked response for fetch/XHR requests whose URL contains `url` (a regular expression when `regex` is set). */
export interface MockRule { id: number; url: string; regex?: boolean; method?: string; status: number; body: string; contentType?: string; headers?: Record<string, string> }

const BODY_MAX = 65536;

export function pageHooks(mocks: MockRule[] = []): string {
  return String.raw`(() => {
  if (/(^|\.)accounts\.google\.com$/.test(location.hostname) || window.__vbHooked) return;
  Object.defineProperty(window, '__vbHooked', { value: true });
  const MOCKS = ${JSON.stringify(mocks)};
  // The app swaps the rules in place, so a new mock applies without a reload.
  Object.defineProperty(window, '__vbMocks', { value: (m) => { MOCKS.length = 0; MOCKS.push(...m); } });
  const BODY_MAX = ${BODY_MAX};
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
  const textish = (type) => /json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(type || '');
  const bodyText = (b) => { if (b == null) return undefined; if (typeof b === 'string') return b.slice(0, BODY_MAX); if (b instanceof URLSearchParams) return String(b).slice(0, BODY_MAX); if (b instanceof FormData) { const o = []; for (const [k, v] of b) o.push(k + '=' + (typeof v === 'string' ? v : '[file ' + v.name + ']')); return o.join('&').slice(0, BODY_MAX); } return '[' + (b.constructor && b.constructor.name || 'binary') + ']'; };
  const headerObj = (h) => { const o = {}; try { h.forEach((v, k) => { o[k] = v; }); } catch {} return o; };
  const matches = (m, url) => { if (m.regex) { try { return new RegExp(m.url).test(url); } catch { return false; } } return url.includes(m.url); };
  const findMock = (method, url) => MOCKS.find((m) => (!m.method || m.method.toUpperCase() === method) && matches(m, url));
  let seq = 0;
  const origFetch = window.fetch;
  if (origFetch) window.fetch = async function (input, init) {
    const url = abs(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const rid = 'f' + (++seq) + '.' + Math.random().toString(36).slice(2, 7);
    const t0 = performance.now();
    send('netstart', { rid, method, url });
    const reqBody = bodyText(init && init.body);
    const reqHeaders = init && init.headers ? headerObj(new Headers(init.headers)) : {};
    const mock = findMock(method, url);
    if (mock) {
      const headers = { 'content-type': mock.contentType || 'application/json', ...(mock.headers || {}) };
      send('net', { rid, via: 'fetch', method, url, status: mock.status, type: headers['content-type'], ms: 0, mocked: mock.id });
      send('netbody', { rid, reqBody, reqHeaders, resBody: String(mock.body).slice(0, BODY_MAX), resHeaders: headers });
      return new Response(mock.body, { status: mock.status, headers });
    }
    try {
      const r = await origFetch.apply(this, arguments);
      const type = r.headers.get('content-type') || '';
      send('net', { rid, via: 'fetch', method, url: r.url || url, status: r.status, type, ms: Math.round(performance.now() - t0) });
      if (textish(type)) r.clone().text().then((t) => send('netbody', { rid, reqBody, reqHeaders, resBody: t.slice(0, BODY_MAX), resHeaders: headerObj(r.headers) })).catch(() => {});
      else send('netbody', { rid, reqBody, reqHeaders, resHeaders: headerObj(r.headers) });
      return r;
    } catch (e) { send('net', { rid, via: 'fetch', method, url, error: String(e && e.message || e), ms: Math.round(performance.now() - t0) }); throw e; }
  };
  const XP = XMLHttpRequest.prototype, XO = XP.open, XS = XP.send, XH = XP.setRequestHeader;
  XP.open = function (method, url) { this.__vb = { method: String(method).toUpperCase(), url: abs(url), headers: {} }; return XO.apply(this, arguments); };
  XP.setRequestHeader = function (k, v) { if (this.__vb) this.__vb.headers[k] = v; return XH.apply(this, arguments); };
  XP.send = function (body) {
    const info = this.__vb;
    if (!info) return XS.apply(this, arguments);
    const rid = 'x' + (++seq) + '.' + Math.random().toString(36).slice(2, 7);
    const t0 = performance.now();
    send('netstart', { rid, method: info.method, url: info.url });
    const reqBody = bodyText(body);
    const mock = findMock(info.method, info.url);
    if (mock) {
      const xhr = this; const type = mock.contentType || 'application/json';
      const headers = { 'content-type': type, ...(mock.headers || {}) };
      const raw = String(mock.body);
      let parsed = raw; if (xhr.responseType === 'json') { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
      const def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
      setTimeout(() => {
        def('readyState', 4); def('status', mock.status); def('statusText', 'OK'); def('responseURL', info.url);
        def('responseText', raw); def('response', parsed);
        xhr.getAllResponseHeaders = () => Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n');
        xhr.getResponseHeader = (k) => headers[String(k).toLowerCase()] ?? null;
        for (const ev of ['readystatechange', 'load', 'loadend']) xhr.dispatchEvent(new Event(ev));
        send('net', { rid, via: 'xhr', method: info.method, url: info.url, status: mock.status, type, ms: 0, mocked: mock.id });
        send('netbody', { rid, reqBody, reqHeaders: info.headers, resBody: raw.slice(0, BODY_MAX), resHeaders: headers });
      }, 0);
      return;
    }
    this.addEventListener('loadend', () => {
      const type = this.getResponseHeader('content-type') || '';
      send('net', { rid, via: 'xhr', method: info.method, url: this.responseURL || info.url, status: this.status, type, error: this.status === 0 ? 'failed' : undefined, ms: Math.round(performance.now() - t0) });
      let resBody; try { if (textish(type) && (this.responseType === '' || this.responseType === 'text')) resBody = String(this.responseText).slice(0, BODY_MAX); else if (this.responseType === 'json') resBody = JSON.stringify(this.response).slice(0, BODY_MAX); } catch {}
      const resHeaders = {}; for (const line of (this.getAllResponseHeaders() || '').trim().split(/[\r\n]+/)) { const i = line.indexOf(':'); if (i > 0) resHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
      send('netbody', { rid, reqBody, reqHeaders: info.headers, resBody, resHeaders });
    });
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
}

export const RELAY = String.raw`document.addEventListener('__vb_hook', (e) => { try { webkit.messageHandlers.vibrato.postMessage(JSON.parse(e.detail)); } catch {} });`;

/** Defines globalThis.__vb in the isolated world (idempotent). Prepended to every agent evaluation. */
export const AGENT_HELPERS = String.raw`
if (!globalThis.__vb) {
  const byEl = new WeakMap(); const byRef = new Map(); let n = 0;
  const refOf = (el) => { let r = byEl.get(el); if (!r) { r = 'e' + (++n); byEl.set(el, r); byRef.set(r, new WeakRef(el)); } return r; };
  const IMPLICIT = { A: (el) => el.hasAttribute('href') ? 'link' : '', BUTTON: () => 'button', SELECT: (el) => el.multiple ? 'listbox' : 'combobox', TEXTAREA: () => 'textbox',
    IMG: (el) => el.getAttribute('alt') === '' ? '' : 'img', H1: () => 'heading', H2: () => 'heading', H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    NAV: () => 'navigation', MAIN: () => 'main', HEADER: () => 'banner', FOOTER: () => 'contentinfo', ASIDE: () => 'complementary', FORM: () => 'form', DIALOG: () => 'dialog', SECTION: (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : '',
    UL: () => 'list', OL: () => 'list', LI: () => 'listitem', TABLE: () => 'table', TR: () => 'row', TD: () => 'cell', TH: () => 'columnheader', OPTION: () => 'option',
    P: () => 'paragraph', LABEL: () => 'label', SUMMARY: () => 'button', PROGRESS: () => 'progressbar',
    INPUT: (el) => ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', hidden: '', file: 'button' })[el.type] ?? 'textbox' };
  const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'option', 'tab', 'menuitem', 'switch', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
  const LANDMARK = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'form', 'dialog', 'region', 'search', 'alertdialog', 'tablist', 'menu', 'menubar']);
  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r.split(' ')[0]; if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox'; const f = IMPLICIT[el.tagName]; return f ? f(el) : ''; };
  const clip = (s, n = 100) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  // Secret fields: their value never leaves the page (snapshots, results, picks).
  const secret = (el) => el.tagName === 'INPUT' && (el.type === 'password' || /(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(el.getAttribute('autocomplete') || ''));
  const valueOf = (el) => (!('value' in el) ? undefined : secret(el) ? (el.value ? '[hidden]' : '') : String(el.value));
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
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse';
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'SVG', 'PATH']);
  // Viewport rect of an element, mapped out of same-origin iframes into the top document.
  const rectOf = (el) => {
    const r = el.getBoundingClientRect(); let x = r.left, y = r.top;
    let w = el.ownerDocument.defaultView;
    while (w && w !== top && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
    return { x, y, w: r.width, h: r.height };
  };
  const describeLine = (el, r, name, clickable) => {
    let line = r + (name ? ' ' + JSON.stringify(name) : '');
    if (r === 'heading') line += ' [level=' + (Number(el.getAttribute('aria-level')) || Number(el.tagName[1]) || 2) + ']';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]';
    if (el.checked || el.getAttribute('aria-checked') === 'true') line += ' [checked]';
    if (el.getAttribute('aria-expanded')) line += ' [expanded=' + el.getAttribute('aria-expanded') + ']';
    if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) line += ' [selected]';
    if (el === document.activeElement) line += ' [focused]';
    if (clickable) line += ' [clickable]';
    return line;
  };
  /**
   * opts: maxDepth, maxLines, interactive (only elements you can act on, flat), compact (no text runs already in a
   * name, no unnamed list wrappers), skeleton (landmarks and headings with counts; drill in with a root ref).
   */
  const snapshot = (root, opts = {}) => {
    const maxDepth = opts.maxDepth || 40, maxLines = opts.maxLines || 3000;
    const lines = []; const rects = [];
    const push = (depth, s) => { if (lines.length < maxLines) lines.push('  '.repeat(opts.interactive ? 0 : depth) + '- ' + s); };
    const countInteractive = (el) => { let c = 0; for (const x of el.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=""],[contenteditable=true]')) if (!hidden(x)) c++; return c; };
    const walk = (node, depth, inInteractive) => {
      if (lines.length >= maxLines || depth > maxDepth) return;
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (opts.interactive || opts.skeleton || inInteractive) continue;
          const t = clip(child.textContent, 160);
          if (t && !(opts.compact && t.length < 2)) push(depth, 'text: ' + JSON.stringify(t));
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (SKIP.has(el.tagName.toUpperCase()) || hidden(el)) continue;
        const role = roleOf(el);
        if (el.tagName === 'IFRAME') {
          let doc = null; try { doc = el.contentDocument; } catch {}
          push(depth, 'iframe ' + JSON.stringify(el.src || '') + ' [ref=' + refOf(el) + ']' + (doc ? '' : ' (cross-origin)'));
          if (doc && doc.body) walk(doc.body, depth + 1, false);
          continue;
        }
        if (opts.skeleton) {
          if (LANDMARK.has(role) || role === 'heading') {
            const name = nameOf(el, role);
            const ref = refOf(el);
            push(depth, describeLine(el, role, name, false) + ' [ref=' + ref + ']' + (role === 'heading' ? '' : ' (' + countInteractive(el) + ' interactive)'));
            if (role !== 'heading') walk(el.shadowRoot || el, depth + 1, inInteractive);
          } else walk(el.shadowRoot || el, depth, inInteractive);
          continue;
        }
        const clickable = !role && !inInteractive && getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
        if (role || clickable) {
          const r = role || 'generic';
          const name = nameOf(el, r);
          const interactive = INTERACTIVE.has(r) || clickable;
          if (opts.compact && !interactive && !name && (r === 'list' || r === 'listitem' || r === 'paragraph' || r === 'row' || r === 'cell')) { walk(el.shadowRoot || el, depth, inInteractive); continue; }
          if (opts.interactive && !interactive) { walk(el.shadowRoot || el, depth, inInteractive); continue; }
          let line = describeLine(el, r, name, clickable);
          if (interactive || el.tagName === 'IMG') { const ref = refOf(el); line += ' [ref=' + ref + ']'; if (interactive) rects.push({ ref, ...rectOf(el) }); }
          if (r === 'textbox' || r === 'searchbox' || r === 'spinbutton' || r === 'combobox') { const v = valueOf(el); if (v) line += ': ' + JSON.stringify(clip(v, 120)); }
          if (r === 'link' && el.getAttribute('href')) line += ' -> ' + clip(el.getAttribute('href'), 120);
          push(depth, line);
          if (!['textbox', 'searchbox', 'img', 'combobox', 'listbox', 'slider', 'spinbutton', 'progressbar'].includes(r) || el.tagName === 'SELECT') walk(el.shadowRoot || el, depth + 1, inInteractive || interactive);
        } else {
          walk(el.shadowRoot || el, depth, inInteractive);
        }
      }
    };
    walk(root, 0, false);
    if (lines.length >= maxLines) lines.push('- … (truncated; use skeleton, then a root ref or selector to narrow it)');
    return { text: lines.join('\n'), rects };
  };
  const find = (target) => {
    if (!target) throw new Error('INVALID_ARGS: ref or selector required');
    const ref = String(target).replace(/^@?s\d+:/, '').replace(/^@/, '');
    if (/^e\d+$/.test(ref)) { const el = byRef.get(ref)?.deref(); if (!el || !el.isConnected) throw new Error('STALE_REF: ref ' + ref + ' is gone from the page'); return el; }
    let el; try { el = document.querySelector(target); } catch { throw new Error('INVALID_ARGS: bad selector ' + target); }
    if (!el) throw new Error('NOT_FOUND: no element matches ' + target);
    return el;
  };
  const hitName = (hit) => hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  /** Live checks before an action: kind = click | type | select | hover. Returns { ok, code, detail, point, rect }. */
  const check = async (el, kind) => {
    if (!el.isConnected) return { ok: false, code: 'STALE_REF', detail: 'element was removed', terminal: true };
    if (kind === 'type' && !(el.isContentEditable || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.readOnly && !['checkbox', 'radio', 'button', 'submit', 'file', 'range', 'color'].includes(el.type))))
      return { ok: false, code: 'NOT_EDITABLE', detail: 'element does not accept text', terminal: true };
    if (kind === 'select' && el.tagName !== 'SELECT') return { ok: false, code: 'INVALID_ARGS', detail: 'not a <select>; click the option instead', terminal: true };
    if (hidden(el) || Number(getComputedStyle(el).opacity) === 0) return { ok: false, code: 'NOT_VISIBLE', detail: 'element is hidden' };
    if (kind !== 'hover' && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return { ok: false, code: 'NOT_ENABLED', detail: 'element is disabled' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 60)); // not rAF: it pauses while the window is covered
    const a = rectOf(el);
    await new Promise((r) => setTimeout(r, 50));
    const b = rectOf(el);
    if (b.w === 0 || b.h === 0) return { ok: false, code: 'NOT_VISIBLE', detail: 'element has no size' };
    if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.w - b.w) > 1) return { ok: false, code: 'NOT_STABLE', detail: 'element is moving' };
    // Five candidate points (center first); the action uses the first one that reaches the element.
    const pts = [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]].map(([fx, fy]) => ({ x: b.x + b.w * fx, y: b.y + b.h * fy }));
    let blocker = null;
    for (const p of pts) {
      const hit = document.elementFromPoint(p.x, p.y);
      if (!hit || hit === el || el.contains(hit) || hit.tagName === 'IFRAME' || (el.tagName === 'LABEL' && hit === el.control) || (hit.tagName === 'LABEL' && hit.control === el)) return { ok: true, point: p, rect: b };
      blocker = blocker || hit;
    }
    return { ok: false, code: 'OCCLUDED', detail: 'covered by ' + (blocker ? hitName(blocker) : 'another element'), rect: b };
  };
  const state = (el) => {
    const o = { tag: el.tagName.toLowerCase(), role: roleOf(el) || undefined, name: nameOf(el, roleOf(el)) || undefined };
    const v = valueOf(el); if (v !== undefined) o.value = clip(v, 200);
    if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) o.checked = el.checked;
    if (el.getAttribute('aria-expanded')) o.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.tagName === 'SELECT') o.selected = [...el.selectedOptions].map((x) => x.label.trim());
    o.focused = el === document.activeElement; o.connected = el.isConnected;
    return o;
  };
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  /** A Playwright locator expression for the element (getByTestId > getByLabel > getByRole+name > placeholder > css). */
  const locator = (el) => {
    const q = (s) => JSON.stringify(s);
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (tid) return 'page.getByTestId(' + q(tid) + ')';
    const role = roleOf(el); const name = nameOf(el, role);
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.labels && el.labels[0] && clip(el.labels[0].textContent)) return 'page.getByLabel(' + q(clip(el.labels[0].textContent)) + ')';
    if (role && name && (INTERACTIVE.has(role) || role === 'heading')) return 'page.getByRole(' + q(role) + ', { name: ' + q(name) + ' })';
    if (el.getAttribute('placeholder')) return 'page.getByPlaceholder(' + q(el.getAttribute('placeholder')) + ')';
    return 'page.locator(' + q(cssPath(el)) + ')';
  };
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const box = (cs, k) => [px(cs[k + 'Top']), px(cs[k + 'Right']), px(cs[k + 'Bottom']), px(cs[k + 'Left'])];
  /** Measurements for 실측: box model, typography, colors; with 'other', the gaps between the two. */
  const measure = (el, other) => {
    const cs = getComputedStyle(el); const r = rectOf(el);
    const m = {
      element: locator(el), rect: { x: px(r.x), y: px(r.y + scrollY), width: px(r.w), height: px(r.h) },
      padding: box(cs, 'padding'), margin: box(cs, 'margin'), border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
      borderRadius: cs.borderRadius, boxSizing: cs.boxSizing, display: cs.display,
      font: { family: cs.fontFamily, size: px(cs.fontSize), weight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, align: cs.textAlign },
      color: cs.color, background: cs.backgroundColor, opacity: cs.opacity,
    };
    if (/flex|grid/.test(cs.display)) Object.assign(m, { gap: cs.gap, justify: cs.justifyContent, alignItems: cs.alignItems, direction: cs.flexDirection });
    if (cs.boxShadow !== 'none') m.boxShadow = cs.boxShadow;
    if (other) {
      const o = rectOf(other);
      m.other = locator(other);
      m.distance = { horizontal: px(o.x >= r.x + r.w ? o.x - (r.x + r.w) : r.x >= o.x + o.w ? r.x - (o.x + o.w) : 0), vertical: px(o.y >= r.y + r.h ? o.y - (r.y + r.h) : r.y >= o.y + o.h ? r.y - (o.y + o.h) : 0) };
      m.offset = { dx: px(o.x - r.x), dy: px(o.y - r.y) };
    }
    return m;
  };
  /** What the picker (and the element inspector's "send to agent") hands to the composer. */
  const pickData = (el) => {
    let html = el.outerHTML; if (secret(el)) html = html.replace(/value="[^"]*"/g, 'value="[hidden]"');
    return { ref: refOf(el), rect: rectOf(el), locator: locator(el), selector: cssPath(el), role: roleOf(el), name: nameOf(el, roleOf(el)), text: clip(el.innerText || el.textContent, 300), html: html.length > 4000 ? html.slice(0, 4000) + '…' : html, measure: measure(el), url: location.href };
  };
  /** Element picker: hover boxes and the picked element go out through the native bridge. */
  let picking = null;
  const pick = (on) => {
    if (picking) { removeEventListener('mousemove', picking.move, true); removeEventListener('click', picking.click, true); removeEventListener('keydown', picking.key, true); picking = null; }
    if (!on) return;
    const post = (m) => { try { webkit.messageHandlers.vibrato.postMessage(m); } catch {} };
    let last = 0;
    const move = (e) => { const now = Date.now(); if (now - last < 40) return; last = now; const el = e.target instanceof Element ? e.target : null; if (!el) return; post({ kind: 'pick-hover', rect: rectOf(el), label: hitName(el) }); };
    const click = (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const el = e.target instanceof Element ? e.target : null; pick(false); if (!el) return;
      post({ kind: 'pick', ...pickData(el) });
    };
    const key = (e) => { if (e.key === 'Escape') { pick(false); post({ kind: 'pick-cancel' }); } };
    addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', key, true);
    picking = { move, click, key };
  };
  const rectsFor = (refs) => refs.map((r) => { const el = byRef.get(r)?.deref(); if (!el || !el.isConnected || hidden(el)) return null; const b = rectOf(el); return b.w && b.h ? { ref: r, ...b } : null; }).filter(Boolean);
  globalThis.__vb = { snapshot, find, check, state, locator, measure, pick, pickData, refOf, rectOf, rectsFor, secret, cssPath, hitName, clip, hidden };
}
`;

/**
 * Pure CSS helpers of the element inspector, kept apart so tests can run them: top-level list splitting that
 * respects brackets and quotes, selector specificity (with :is/:not/:has taking their most specific argument,
 * :where counting nothing and nth-child(… of S) adding S) and declaration parsing of a rule's cssText.
 */
export const INSPECT_CORE = String.raw`
const splitTop = (s, sep = ',') => {
  const out = []; let d = 0, q = '', st = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
    else if (ch === sep && !d) { out.push(s.slice(st, i).trim()); st = i + 1; }
  }
  out.push(s.slice(st).trim());
  return out.filter(Boolean);
};
const cmpArr = (x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const LEGACY_PSEUDO = ['before', 'after', 'first-line', 'first-letter'];
const specificity = (s) => {
  let a = 0, b = 0, c = 0, i = 0;
  const ident = () => { while (i < s.length && (/[\w-]/.test(s[i]) || s.charCodeAt(i) > 127 || s[i] === '\\')) { if (s[i] === '\\') i++; i++; } };
  const args = () => {
    let d = 0; const st = i + 1;
    for (; i < s.length; i++) { const ch = s[i]; if (ch === '\\') { i++; continue; } if (ch === '(') d++; else if (ch === ')' && !--d) { i++; return s.slice(st, i - 1); } }
    return s.slice(st);
  };
  const add = (list) => { let best = [0, 0, 0]; for (const p of splitTop(list)) { const x = specificity(p); if (cmpArr(x, best) > 0) best = x; } a += best[0]; b += best[1]; c += best[2]; };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '#') { a++; i++; ident(); continue; }
    if (ch === '.') { b++; i++; ident(); continue; }
    if (ch === '[') { b++; while (i < s.length && s[i] !== ']') { if (s[i] === '\\') i++; i++; } i++; continue; }
    if (ch === ':') {
      const isEl = s[i + 1] === ':'; i += isEl ? 2 : 1;
      const st = i; ident(); const name = s.slice(st, i).toLowerCase();
      const arg = s[i] === '(' ? args() : null;
      if (isEl || LEGACY_PSEUDO.includes(name)) { c++; continue; }
      if (name === 'where') continue;
      if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name)) { add(arg || ''); continue; }
      b++;
      if ((name === 'nth-child' || name === 'nth-last-child') && arg && /\sof\s/i.test(arg)) add(arg.replace(/^[\s\S]*?\sof\s/i, ''));
      continue;
    }
    if (/[A-Za-z_-]/.test(ch) || s.charCodeAt(i) > 127) { ident(); c++; continue; }
    i++;
  }
  return [a, b, c];
};
const parseDecls = (text) => {
  const out = [];
  for (const part of splitTop(text || '', ';')) {
    const k = part.indexOf(':'); if (k <= 0) continue;
    let p = part.slice(0, k).trim(); let v = part.slice(k + 1).trim();
    if (!p.startsWith('--')) p = p.toLowerCase();
    const imp = /!\s*important\s*$/i.test(v); if (imp) v = v.replace(/\s*!\s*important\s*$/i, '');
    out.push({ p, v, imp });
  }
  return out;
};
`;

/**
 * Element inspector (isolated world, every frame, from document start). With ⌥ held the element under the pointer
 * gets a hover box; ⌥+click selects it without the page seeing the click (capture listeners registered before any
 * page script, so they run first), and the inspection goes out through the native bridge. __vb.inspect(el) is also
 * called by the browser window to walk the tree (parent, child, sibling) in the main frame.
 *
 * An inspection bundles what one usually opens several DevTools panes for: the element and its tree around it,
 * box model, the matched rules in cascade order with overridden declarations and resolved var()s, inherited and
 * ::before/::after rules, every computed value with the rule it came from, and accessibility / locator info.
 */
export const INSPECTOR = String.raw`
if (globalThis.__vb && !globalThis.__vb.inspect) {
  const V = globalThis.__vb;
  ${INSPECT_CORE}
  const post = (m) => { try { webkit.messageHandlers.vibrato.postMessage(m); } catch {} };
  const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-width', 'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position', 'font-feature-settings', 'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'font-synthesis', 'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-size-adjust', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent', 'text-transform', 'text-shadow', 'text-rendering', 'text-wrap', 'text-wrap-mode', 'text-wrap-style', 'text-underline-position', 'text-underline-offset', 'white-space', 'white-space-collapse', 'word-break', 'overflow-wrap', 'word-wrap', 'line-break', 'hyphens', 'tab-size', 'direction', 'writing-mode', 'visibility', 'cursor', 'pointer-events', 'list-style-type', 'list-style-position', 'list-style-image', 'quotes', 'caret-color', 'accent-color', 'color-scheme', 'border-collapse', 'border-spacing', 'empty-cells', 'caption-side', 'orphans', 'widows', 'paint-order', 'image-rendering', '-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width', '-webkit-line-clamp']);
  const STATE_RE = /:(hover|focus|focus-visible|focus-within|active|visited|checked|target|open|placeholder-shown)\b/;
  const PSEUDO_RE = /(::[\w-]+(\([^)]*\))?|:(before|after|first-line|first-letter))$/;
  const SHOWN_PSEUDO = ['::before', '::after', '::marker', '::placeholder', '::first-line', '::first-letter', '::selection', '::backdrop'];
  const short = (el) => {
    let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += '.' + cls.slice(0, 2).join('.') + (cls.length > 2 ? '…' : '');
    return s;
  };
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const lh = new Map();
  const longhands = (p) => {
    if (p.startsWith('--')) return [p];
    let l = lh.get(p);
    if (!l) { const s = document.createElement('div').style; s.setProperty(p, 'inherit'); l = Array.from(s); if (!l.length) l = [p]; lh.set(p, l); }
    return l;
  };
  const sheetName = (s) => {
    const n = s.ownerNode; const vid = n && n.getAttribute && n.getAttribute('data-vite-dev-id');
    const src = vid || s.href;
    if (n && n.hasAttribute && n.hasAttribute('data-vibrato-inspector')) return 'vibrato';
    if (!src) return n && n.tagName === 'STYLE' ? '<style>' : 'constructed';
    return src.split(/[?#]/)[0].split('/').filter(Boolean).slice(-2).join('/');
  };
  /** Every style rule reachable from a document or shadow root, flattened with its conditions, layer and order. */
  // Rules keep one id across inspections (the panel edits them by id); disabled declarations live here per rule.
  const ruleIds = new WeakMap(), ruleById = new Map(); let ruleSeq = 0;
  const idOf = (r) => { let id = ruleIds.get(r); if (!id) { id = 'r' + (++ruleSeq); ruleIds.set(r, id); ruleById.set(id, new WeakRef(r)); } return id; };
  const disabled = new Map();
  const withOff = (key, decls) => {
    for (const e of [...(disabled.get(key) || [])].sort((x, y) => x.i - y.i)) decls.splice(Math.min(e.i, decls.length), 0, { p: e.p, v: e.v, imp: e.imp, off: true });
    return decls;
  };
  const rulesIn = (root) => {
    const rules = [], layers = [], unreadable = []; let order = 0;
    const layerIdx = (name) => { let i = layers.indexOf(name); if (i < 0) { layers.push(name); i = layers.length - 1; } return i; };
    const nest = (sel, parent) => parent ? (sel.includes('&') ? sel.replace(/&/g, ':is(' + parent + ')') : ':is(' + parent + ') ' + sel) : sel;
    const walk = (list, ctx) => {
      for (const r of list) {
        const k = r.constructor && r.constructor.name;
        if (k === 'CSSStyleRule') {
          const sel = nest(r.selectorText, ctx.parent);
          rules.push({ id: idOf(r), sel, style: r.style, ctx, order: order++ });
          if (r.cssRules && r.cssRules.length) walk(r.cssRules, { ...ctx, parent: sel });
        } else if (k === 'CSSNestedDeclarations') { if (ctx.parent) rules.push({ id: idOf(r), sel: ctx.parent, style: r.style, ctx, order: order++ }); }
        else if (k === 'CSSMediaRule') { const m = r.media.mediaText; let ok = true; try { ok = matchMedia(m).matches; } catch {} walk(r.cssRules, { ...ctx, at: ctx.at.concat('@media ' + m), ok: ctx.ok && ok }); }
        else if (k === 'CSSSupportsRule') { let ok = true; try { ok = CSS.supports(r.conditionText); } catch {} walk(r.cssRules, { ...ctx, at: ctx.at.concat('@supports ' + r.conditionText), ok: ctx.ok && ok }); }
        else if (k === 'CSSContainerRule') walk(r.cssRules, { ...ctx, at: ctx.at.concat('@container ' + r.conditionText), maybe: true });
        else if (k === 'CSSLayerBlockRule') { const name = (ctx.layer ? ctx.layer + '.' : '') + (r.name || '(anonymous ' + order + ')'); layerIdx(name); walk(r.cssRules, { ...ctx, layer: name, layerIdx: layerIdx(name) }); }
        else if (k === 'CSSLayerStatementRule') { for (const n of r.nameList) layerIdx((ctx.layer ? ctx.layer + '.' : '') + n); }
        else if (k === 'CSSImportRule' && r.styleSheet) {
          const m = r.media && r.media.mediaText; let ok = true; if (m) try { ok = matchMedia(m).matches; } catch {}
          const layer = r.layerName == null ? ctx.layer : (ctx.layer ? ctx.layer + '.' : '') + (r.layerName || '(anonymous)');
          sheet(r.styleSheet, { ...ctx, at: m ? ctx.at.concat('@media ' + m) : ctx.at, ok: ctx.ok && ok, layer, layerIdx: layer == null ? ctx.layerIdx : layerIdx(layer) });
        }
      }
    };
    const sheet = (s, ctx) => {
      if (s.disabled) return;
      let list; try { list = s.cssRules; } catch { unreadable.push(sheetName(s)); return; }
      const m = s.media && s.media.mediaText; let ok = true; if (m) try { ok = matchMedia(m).matches; } catch {}
      walk(list, { ...ctx, src: sheetName(s), at: m ? ctx.at.concat('@media ' + m) : ctx.at, ok: ctx.ok && ok });
    };
    const base = { src: '', at: [], ok: true, layer: null, layerIdx: null, parent: null, maybe: false };
    for (const s of root.styleSheets || []) sheet(s, base);
    for (const s of root.adoptedStyleSheets || []) sheet(s, base);
    return { rules, unreadable };
  };
  const matches = (el, sel) => { try { return el.matches(sel); } catch { return false; } };
  /** Rules matching el (best matching selector's specificity) and the pseudo-element rules hanging off it. */
  const matched = (el, store) => {
    const own = [], pseudo = new Map();
    for (const r of store.rules) {
      if (!r.ctx.ok) continue;
      r.parts = r.parts || splitTop(r.sel);
      r.pe = r.pe ?? r.parts.some((p) => PSEUDO_RE.test(p));
      if (!r.pe && !matches(el, r.sel)) continue;
      let best = null;
      for (const p of r.parts) {
        const m = r.pe ? PSEUDO_RE.exec(p) : null;
        if (m) {
          const name = m[0].startsWith('::') ? m[0].replace(/\(.*$/, '') : ':' + m[0];
          if (!SHOWN_PSEUDO.includes(name) || !matches(el, p.slice(0, m.index) || '*')) continue;
          const list = pseudo.get(name) || []; if (!list.some((x) => x.r === r)) list.push({ r, spec: specificity(p) }); pseudo.set(name, list);
        } else if (r.parts.length === 1 || matches(el, p)) { const s = specificity(p); if (!best || cmpArr(s, best) > 0) best = s; }
      }
      if (best) own.push({ r, spec: best });
    }
    return { own, pseudo };
  };
  const group = (m) => ({ id: m.r.id, sel: m.r.sel, src: m.r.ctx.src, at: m.r.ctx.at.join(' '), layer: m.r.ctx.layer || undefined, layerIdx: m.r.ctx.layerIdx, maybe: m.r.ctx.maybe || undefined, state: STATE_RE.test(m.r.sel) || undefined, specArr: m.spec, spec: m.spec.join(','), order: m.r.order, decls: withOff(m.r.id, parseDecls(m.r.style.cssText)) });
  // element.style is always there (empty too) so the panel can add to it.
  const inlineGroup = (el) => ({ id: 'inline', sel: 'element.style', inline: true, specArr: [1, 0, 0, 0], order: 1e9, layerIdx: null, decls: withOff('inline:' + V.refOf(el), parseDecls(el.style.cssText)) });
  const rank = (g, imp) => [imp ? 1 : 0, g.inline ? 1 : 0, g.layerIdx == null ? (imp ? -1 : 1e6) : (imp ? 1e6 - g.layerIdx : g.layerIdx), ...g.specArr, g.order];
  const winners = (groups, keep) => {
    const win = new Map();
    for (const g of groups) for (const d of g.decls) {
      if (d.off) continue;
      const k = rank(g, d.imp);
      for (const l of longhands(d.p)) { if (keep && !keep(l)) continue; const w = win.get(l); if (!w || cmpArr(k, w.k) >= 0) win.set(l, { k, d, g }); }
    }
    return win;
  };
  const sortGroups = (gs) => gs.sort((x, y) => cmpArr(rank(y, false), rank(x, false)));
  const groupsFor = (el, store) => { const m = matched(el, store); const gs = m.own.map(group); gs.push(inlineGroup(el)); return { gs: sortGroups(gs), pseudo: m.pseudo }; };
  const where = (g) => g.inline ? 'element.style' : g.sel + (g.src ? ' — ' + g.src : '');
  const vars = (d, cs) => {
    if (!d.v.includes('var(')) return;
    const out = [];
    for (const m of d.v.matchAll(/var\(\s*(--[\w-]+)/g)) { if (out.length >= 6) break; if (!out.some((x) => x[0] === m[1])) out.push([m[1], cs.getPropertyValue(m[1]).trim()]); }
    if (out.length) d.vars = out;
  };
  const clean = (g) => { const { specArr, order, layerIdx, ...rest } = g; return rest; };
  /** sRGB bytes of any CSS color (oklch included) by painting one pixel. */
  let ctx2d = null;
  const rgba = (color) => {
    try {
      ctx2d = ctx2d || Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
      ctx2d.clearRect(0, 0, 1, 1); ctx2d.fillStyle = '#000'; ctx2d.fillStyle = color; ctx2d.fillRect(0, 0, 1, 1);
      const p = ctx2d.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2], p[3] / 255];
    } catch { return null; }
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  /** Text contrast against the solid colour behind the element (background images are ignored). */
  const contrast = (el, cs) => {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
    const layers = []; let imaged = false;
    for (let a = el; a; a = parentOf(a)) {
      const s = getComputedStyle(a); if (s.backgroundImage !== 'none') imaged = true;
      const c = rgba(s.backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = [255, 255, 255];
    for (const c of layers.reverse()) bg = bg.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
    const fg0 = rgba(cs.color); if (!fg0) return;
    const fg = fg0.slice(0, 3).map((v, i) => v * fg0[3] + bg[i] * (1 - fg0[3]));
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    const size = parseFloat(cs.fontSize); const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    return { ratio, large, background: 'rgb(' + bg.map(Math.round).join(', ') + ')', imaged: imaged || undefined };
  };
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const sides = (cs, k, suffix = '') => ['Top', 'Right', 'Bottom', 'Left'].map((s) => px(cs[k + s + suffix]));
  const kidsOf = (list, shadow) => {
    const out = [];
    for (const n of list) {
      if (out.length >= 150) break;
      if (n.nodeType === 3) { const t = V.clip(n.textContent, 80); if (t) out.push({ text: t }); continue; }
      if (n.nodeType !== 1) continue;
      out.push({ ...nodeLine(n, shadow), label: short(n) });
    }
    return out;
  };

  /** One line of the DOM tree: tag, the attributes that identify it, child count or its short text. */
  const shortAttrs = (n) => {
    const all = [...n.attributes]; const out = [];
    for (const a of [...all.filter((x) => x.name === 'id' || x.name === 'class'), ...all.filter((x) => x.name !== 'id' && x.name !== 'class')]) {
      if (out.length >= 4) break;
      const max = a.name === 'class' ? 90 : 50;
      out.push([a.name, V.secret(n) && a.name === 'value' ? '[hidden]' : a.value.length > max ? a.value.slice(0, max) + '…' : a.value]);
    }
    return all.length > out.length ? out.concat([['…', String(all.length - out.length)]]) : out;
  };
  const nodeLine = (n, shadow) => {
    const kids = n.childElementCount + (n.shadowRoot ? n.shadowRoot.childElementCount : 0);
    return { ref: V.refOf(n), tag: n.tagName.toLowerCase(), attrs: shortAttrs(n), kids, text: kids ? undefined : V.clip(n.textContent, 40) || undefined, hidden: V.hidden(n) || undefined, shadow: shadow || undefined };
  };
  /** Children of an ancestor around the chain child (40 at most, the chain child kept in the window). */
  const levelKids = (a, next) => {
    const nodes = [...(a.shadowRoot ? [...a.shadowRoot.children].map((n) => [n, true]) : []), ...[...a.children].map((n) => [n, false])];
    const idx = nodes.findIndex(([n]) => n === next);
    let start = 0, end = nodes.length;
    if (nodes.length > 41) { start = Math.max(0, Math.min(idx - 20, nodes.length - 41)); end = start + 41; }
    return { kidsList: nodes.slice(start, end).map(([n, sh]) => n === next ? { ref: V.refOf(n), chain: true } : nodeLine(n, sh)), before: start || undefined, after: nodes.length - end || undefined };
  };

  const inspect = (el) => {
    const cs = getComputedStyle(el);
    const store = rulesIn(el.getRootNode());
    const stores = new Map([[el.getRootNode(), store]]);
    const storeOf = (a) => { const r = a.getRootNode(); let s = stores.get(r); if (!s) { s = rulesIn(r); stores.set(r, s); } return s; };
    const sources = {};
    const { gs, pseudo } = groupsFor(el, store);
    const win = winners(gs);
    for (const g of gs) for (const d of g.decls) { if (!d.off) d.over = !longhands(d.p).some((l) => win.get(l).d === d) || undefined; vars(d, cs); }
    for (const [l, w] of win) sources[l] = where(w.g);
    // Inherited: declarations of inheritable properties on ancestors, nearest first; the nearest one wins.
    const decided = new Set(win.keys());
    const inherited = [];
    for (let a = parentOf(el), n = 0; a && n < 20; a = parentOf(a), n++) {
      const r = groupsFor(a, storeOf(a)).gs;
      for (const g of r) g.decls = g.decls.filter((d) => !d.p.startsWith('--') && longhands(d.p).some((l) => INHERITED.has(l)));
      const keep = r.filter((g) => g.decls.length);
      if (!keep.length) continue;
      const w = winners(keep, (l) => INHERITED.has(l));
      const acs = getComputedStyle(a);
      // The browser's own stylesheet (form controls' font, say) is invisible here: a value only counts as
      // inherited when the element really ends up with the ancestor's value.
      const reaches = (l) => cs.getPropertyValue(l) === acs.getPropertyValue(l);
      for (const g of keep) for (const d of g.decls) {
        const mine = d.off ? [] : longhands(d.p).filter((l) => INHERITED.has(l) && !decided.has(l) && w.get(l)?.d === d && reaches(l));
        if (!d.off) d.over = !mine.length || undefined;
        for (const l of mine) sources[l] = '↑ ' + short(a) + ' · ' + where(g);
        vars(d, acs);
      }
      for (const l of w.keys()) decided.add(l);
      if (inherited.length < 12) inherited.push({ ref: V.refOf(a), label: short(a), groups: keep.map(clean) });
    }
    const pseudos = [];
    for (const [name, list] of pseudo) {
      const pgs = sortGroups(list.map(group));
      const pw = winners(pgs);
      let pcs = null; try { pcs = getComputedStyle(el, name); } catch {}
      for (const g of pgs) for (const d of g.decls) { if (!d.off) d.over = !longhands(d.p).some((l) => pw.get(l).d === d) || undefined; if (pcs) vars(d, pcs); }
      const content = pcs && (name === '::before' || name === '::after' || name === '::marker') ? pcs.content : undefined;
      pseudos.push({ name, content, groups: pgs.map(clean) });
    }
    const computed = [];
    for (let i = 0; i < cs.length; i++) { const p = cs[i]; computed.push([p, cs.getPropertyValue(p)]); }
    computed.sort((x, y) => x[0].localeCompare(y[0]));
    const r = el.getBoundingClientRect();
    const border = sides(cs, 'border', 'Width'), padding = sides(cs, 'padding');
    const parent = el.parentElement;
    const chain = []; for (let a = parentOf(el); a && chain.length < 40; a = parentOf(a)) chain.unshift(a);
    const path = chain.map((a) => ({ ref: V.refOf(a), label: short(a) }));
    const tree = chain.map((a, i) => ({ ...nodeLine(a), ...levelKids(a, chain[i + 1] || el) }));
    const st = V.state(el);
    const isSecret = V.secret(el);
    const scroller = (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(cs.overflowY)) || (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(cs.overflowX));
    let crossOrigin = false; try { void top.location.href; } catch { crossOrigin = true; }
    return {
      ref: V.refOf(el), label: short(el), tag: el.tagName.toLowerCase(), url: location.href, frame: window !== top || undefined, crossOrigin: crossOrigin || undefined,
      rect: V.rectOf(el), size: { w: px(r.width), h: px(r.height) },
      attrs: [...el.attributes].map((a) => [a.name, isSecret && a.name === 'value' ? '[hidden]' : a.value.length > 1500 ? a.value.slice(0, 1500) + '…' : a.value]),
      text: V.clip(el.innerText || el.textContent, 300) || undefined,
      path, tree, children: [...(el.shadowRoot ? kidsOf(el.shadowRoot.childNodes, true) : []), ...kidsOf(el.childNodes, false)],
      childCount: el.childElementCount + (el.shadowRoot ? el.shadowRoot.childElementCount : 0),
      box: { margin: sides(cs, 'margin'), border, padding, content: { w: px(r.width - border[1] - border[3] - padding[1] - padding[3]), h: px(r.height - border[0] - border[2] - padding[0] - padding[2]) }, sizing: cs.boxSizing },
      rules: gs.map(clean), inherited, pseudos, computed, sources,
      unreadable: store.unreadable.length ? store.unreadable : undefined,
      info: {
        role: st.role, name: st.name, locator: V.locator(el), selector: V.cssPath(el),
        focusable: (el.tabIndex >= 0 && !el.disabled) || undefined, hidden: V.hidden(el) || Number(cs.opacity) === 0 || !r.width || !r.height || undefined,
        scroll: scroller || undefined, contrast: contrast(el, cs),
        parentLayout: parent ? getComputedStyle(parent).display : undefined,
      },
    };
  };
  V.inspect = (target) => inspect(V.find(target));

  /**
   * Live style edits from the panel, on the page's own CSSOM (like DevTools; a reload undoes them):
   * set (value, or rename with old; an empty value removes), toggle (on/off, kept aside while off),
   * addRule (an empty rule in a <style data-vibrato-inspector> of the element's document or shadow root).
   */
  const parseValue = (raw) => { let v = String(raw ?? '').trim().replace(/;+\s*$/, ''); const imp = /!\s*important\s*$/i.test(v); if (imp) v = v.replace(/\s*!\s*important\s*$/i, ''); return { v, imp }; };
  V.cssEdit = (op) => {
    // op.ref owns the edited style (an ancestor's element.style, say); op.inspect is the element to answer with.
    const el = V.find(op.ref);
    const shown = op.inspect ? V.find(op.inspect) : el;
    if (op.action === 'addRule') {
      const sel = String(op.sel || '').trim();
      try { document.querySelector(sel); } catch { throw new Error('INVALID_SELECTOR: ' + sel); }
      if (!sel || /[{}]/.test(sel)) throw new Error('INVALID_SELECTOR: ' + sel);
      const root = el.getRootNode();
      const host = root.nodeType === 11 ? root : (document.head || document.documentElement);
      let node = host.querySelector(':scope > style[data-vibrato-inspector]');
      if (!node) { node = document.createElement('style'); node.setAttribute('data-vibrato-inspector', ''); host.appendChild(node); }
      const sheet = node.sheet; const i = sheet.insertRule(sel + ' {}', sheet.cssRules.length);
      return { rule: idOf(sheet.cssRules[i]), matches: matches(el, sel), data: inspect(shown) };
    }
    let style, key;
    if (op.rule === 'inline') { style = el.style; key = 'inline:' + V.refOf(el); }
    else { const r = ruleById.get(op.rule)?.deref(); if (!r) throw new Error('STALE_RULE: the rule is gone; inspect the element again'); style = r.style; key = op.rule; }
    const list = disabled.get(key) || [];
    const p = String(op.p || '').trim();
    if (!p) throw new Error('INVALID_ARGS: property name required');
    const lower = p.startsWith('--') ? p : p.toLowerCase();
    if (op.action === 'set') {
      const { v, imp } = parseValue(op.v);
      if (v && !lower.startsWith('--') && !CSS.supports(lower, v)) throw new Error('INVALID_VALUE: ' + lower + ': ' + v);
      if (op.old && op.old !== lower) style.removeProperty(op.old);
      const j = list.findIndex((e) => e.p === lower || e.p === op.old); if (j >= 0) list.splice(j, 1);
      if (v) style.setProperty(lower, v, imp ? 'important' : ''); else style.removeProperty(lower);
    } else if (op.action === 'toggle') {
      if (!op.on) {
        const i = parseDecls(style.cssText).findIndex((d) => d.p === lower);
        if (i >= 0) { list.push({ p: lower, v: style.getPropertyValue(lower), imp: style.getPropertyPriority(lower) === 'important', i }); style.removeProperty(lower); }
      } else {
        const j = list.findIndex((e) => e.p === lower);
        if (j >= 0) { const e = list.splice(j, 1)[0]; style.setProperty(e.p, e.v, e.imp ? 'important' : ''); }
      }
    } else throw new Error('INVALID_ARGS: unknown action ' + op.action);
    if (list.length) disabled.set(key, list); else disabled.delete(key);
    return { data: inspect(shown) };
  };

  // ⌥ + pointer: hover box while held, select on click. Nothing of it reaches the page.
  let hoverEl = null, lastMove = 0, at = null;
  const frameOk = (() => { try { void top.location.href; return true; } catch { return false; } })();
  const targetOf = (e) => { const p = e.composedPath ? e.composedPath() : []; const el = p.find((n) => n && n.nodeType === 1) || e.target; return el && el.nodeType === 1 ? el : null; };
  const hoverLabel = (el) => { const r = el.getBoundingClientRect(); return short(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height); };
  const showHover = (el) => { if (!el || el === hoverEl) return; hoverEl = el; if (frameOk) post({ kind: 'inspect-hover', rect: V.rectOf(el), label: hoverLabel(el) }); };
  const clearHover = () => { if (!hoverEl) return; hoverEl = null; post({ kind: 'inspect-hover', rect: null }); };
  addEventListener('mousemove', (e) => {
    at = { x: e.clientX, y: e.clientY };
    if (!e.altKey) { clearHover(); return; }
    const now = Date.now(); if (now - lastMove < 30) return; lastMove = now;
    showHover(targetOf(e));
  }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Alt' && at) showHover(document.elementFromPoint(at.x, at.y)); }, true);
  addEventListener('keyup', (e) => { if (e.key === 'Alt') clearHover(); }, true);
  addEventListener('blur', clearHover);
  addEventListener('mouseout', (e) => { if (!e.relatedTarget) clearHover(); }, true);
  const block = (e) => {
    if (!e.altKey || e.button !== 0 || !e.isTrusted) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const el = targetOf(e); if (!el) return;
    clearHover();
    try { post({ kind: 'inspected', data: inspect(el) }); } catch (err) { post({ kind: 'inspected', error: String(err && err.message || err) }); }
  };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) addEventListener(t, block, true);
}
`;

/** Cookie `domain` (leading dot = subdomains too) matches the page host the way browsers send it. */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return !!d && (h === d || h.endsWith(`.${d}`));
}

/** A human-looking cursor path: a slight bow, a small overshoot and its correction (agent-desktop's motion model). */
export function handPath(from: { x: number; y: number }, to: { x: number; y: number }, seed: number): { points: [number, number][]; ms: number } {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return { points: [[to.x, to.y]], ms: 0 };
  let s = seed >>> 0 || 1;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const side = rand() < 0.5 ? -1 : 1;
  const bow = Math.min(38, dist * 0.055) * side;
  const nx = -dy / dist, ny = dx / dist;
  const cx = from.x + dx * 0.5 + nx * bow, cy = from.y + dy * 0.5 + ny * bow;
  const over = { x: to.x + dx * 0.035, y: to.y + dy * 0.035 };
  const points: [number, number][] = [];
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ex = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * over.x;
    const ey = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * over.y;
    const tremor = Math.sin(t * Math.PI * 7) * 1.1 * (1 - t);
    points.push([Math.round((ex + nx * tremor) * 10) / 10, Math.round((ey + ny * tremor) * 10) / 10]);
  }
  points.push([to.x, to.y]);
  const ms = Math.round(Math.min(320, Math.max(90, 90 + dist * 0.35)));
  return { points, ms };
}

/** Device presets for the mobile view (CSS px, portrait). */
export const DEVICES: { id: string; label: string; width: number; height: number; tablet?: boolean }[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'iphone-15', label: 'iPhone 15', width: 393, height: 852 },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, height: 932 },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915 },
  { id: 'galaxy-s24', label: 'Galaxy S24', width: 384, height: 832 },
  { id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133, tablet: true },
  { id: 'ipad-pro-11', label: 'iPad Pro 11', width: 834, height: 1194, tablet: true },
];
export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
export const TABLET_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Playwright test source from recorded steps. */
export function playwrightScript(title: string, steps: string[]): string {
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${JSON.stringify(title)}, async ({ page }) => {`,
    ...steps.map((s) => `  ${s}`),
    '});',
    '',
  ].join('\n');
}

/** Pixel difference of two same-size BGRA bitmaps: share of changed pixels and a red-marked diff image (BGRA). */
export function diffBitmaps(a: Uint8Array, b: Uint8Array, threshold = 24): { changed: number; total: number; diff: Uint8Array } {
  const total = Math.min(a.length, b.length) / 4;
  const diff = new Uint8Array(total * 4);
  let changed = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]));
    if (d > threshold) { changed++; diff[o] = 40; diff[o + 1] = 40; diff[o + 2] = 255; diff[o + 3] = 255; }
    else { const g = Math.round((b[o] + b[o + 1] + b[o + 2]) / 3 * 0.35 + 160); diff[o] = g; diff[o + 1] = g; diff[o + 2] = g; diff[o + 3] = 255; }
  }
  return { changed, total, diff };
}
