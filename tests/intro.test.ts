import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishIntro, folderReady, foldersToAsk, INTRO_DONE_KEY, needsIntro } from '../web/src/lib/intro.ts';

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

test('intro shows on a fresh install only', () => {
  assert.equal(needsIntro(store()), true);
  assert.equal(needsIntro(store({ [INTRO_DONE_KEY]: '1' })), false);
});

test('an earlier install skips the intro and is marked done', () => {
  const s = store({ 'vibe.cwd': '/Users/me/Desktop/x' });
  assert.equal(needsIntro(s), false);
  assert.equal(s.m.get(INTRO_DONE_KEY), '1');
});

test('?intro=1 forces it', () => {
  assert.equal(needsIntro(store({ [INTRO_DONE_KEY]: '1' }), true), true);
});

test('finishing marks done and opens on VIBE', () => {
  const s = store();
  finishIntro(s);
  assert.equal(s.m.get(INTRO_DONE_KEY), '1');
  assert.equal(s.m.get('vibe.mode.view.v2'), 'vibe');
  assert.equal(needsIntro(s), false);
});

test('storage errors never block the app', () => {
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
  assert.equal(needsIntro(broken), false);
  assert.doesNotThrow(() => finishIntro(broken));
});

test('folders: Full Disk Access covers all, refusals are not asked again', () => {
  assert.equal(folderReady('unknown', true), true);
  assert.equal(folderReady('granted', false), true);
  assert.equal(folderReady('unknown', false), false);
  assert.deepEqual(foldersToAsk({ desktop: 'granted', documents: 'denied', downloads: 'unknown' }, false), ['downloads']);
  assert.deepEqual(foldersToAsk({}, true), []);
});
