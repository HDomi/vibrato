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
      let html = el.outerHTML; if (secret(el)) html = html.replace(/value="[^"]*"/g, 'value="[hidden]"');
      post({ kind: 'pick', ref: refOf(el), rect: rectOf(el), locator: locator(el), selector: cssPath(el), role: roleOf(el), name: nameOf(el, roleOf(el)), text: clip(el.innerText || el.textContent, 300), html: html.length > 4000 ? html.slice(0, 4000) + '…' : html, measure: measure(el), url: location.href });
    };
    const key = (e) => { if (e.key === 'Escape') { pick(false); post({ kind: 'pick-cancel' }); } };
    addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', key, true);
    picking = { move, click, key };
  };
  const rectsFor = (refs) => refs.map((r) => { const el = byRef.get(r)?.deref(); if (!el || !el.isConnected || hidden(el)) return null; const b = rectOf(el); return b.w && b.h ? { ref: r, ...b } : null; }).filter(Boolean);
  globalThis.__vb = { snapshot, find, check, state, locator, measure, pick, refOf, rectOf, rectsFor, secret };
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
