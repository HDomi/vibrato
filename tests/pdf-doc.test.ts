import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  assemblePdf, duplicatePages, exportScale, isEncrypted, MAX_AREA, MAX_SIDE, movePages, nudgePages, pageImageName,
  pagesOf, PdfLockedError, removePages, rotatePages, type PageRef, type PdfSource,
} from '../web/src/lib/pdfDoc';

/** A PDF whose page i is (100 + i) pt wide, so output pages can be traced back to their source. */
async function makePdf(n: number, offset = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([100 + offset + i, 200]);
  return doc.save();
}

async function source(id: string, n: number, offset = 0): Promise<PdfSource> {
  return { id, name: `${id}.pdf`, bytes: await makePdf(n, offset), pageCount: n, locked: false };
}

const keys = (pages: PageRef[], idx: number[]) => new Set(idx.map((i) => pages[i].key));
const sig = (pages: PageRef[]) => pages.map((p) => `${p.src}${p.index}`).join(' ');

test('pdf pages: remove, duplicate, rotate', async () => {
  const a = pagesOf(await source('a', 4));
  assert.equal(sig(removePages(a, keys(a, [0, 2]))), 'a1 a3');
  const dup = duplicatePages(a, keys(a, [1, 3]));
  assert.equal(sig(dup.pages), 'a0 a1 a1 a2 a3 a3');
  assert.equal(dup.added.length, 2);
  assert.equal(new Set(dup.pages.map((p) => p.key)).size, 6, 'copies get their own keys');
  const r = rotatePages(rotatePages(a, keys(a, [0]), -90), keys(a, [0, 1]), 180);
  assert.deepEqual(r.map((p) => p.rotate), [90, 180, 0, 0]);
});

test('pdf pages: move a selection block and nudge it', async () => {
  const a = pagesOf(await source('a', 5));
  assert.equal(sig(movePages(a, keys(a, [3]), 0)), 'a3 a0 a1 a2 a4');
  assert.equal(sig(movePages(a, keys(a, [0]), 5)), 'a1 a2 a3 a4 a0');
  assert.equal(sig(movePages(a, keys(a, [0, 2]), 4)), 'a1 a3 a0 a2 a4');
  assert.equal(sig(movePages(a, keys(a, [1, 2]), 2)), sig(a), 'dropping onto itself changes nothing');
  assert.equal(sig(nudgePages(a, keys(a, [1, 2]), -1)), 'a1 a2 a0 a3 a4');
  assert.equal(sig(nudgePages(a, keys(a, [1, 2]), 1)), 'a0 a3 a1 a2 a4');
  assert.equal(nudgePages(a, keys(a, [0]), -1), a);
  assert.equal(nudgePages(a, keys(a, [4]), 1), a);
});

test('pdf assemble: merge, reorder, duplicate and rotate across files', async () => {
  const a = await source('a', 3);
  const b = await source('b', 2, 50);
  const sources = new Map([[a.id, a], [b.id, b]]);
  let pages = [...pagesOf(a), ...pagesOf(b)];
  pages = movePages(pages, keys(pages, [3]), 0); // b0 first
  pages = duplicatePages(pages, keys(pages, [2])).pages; // a1 twice
  pages = rotatePages(pages, keys(pages, [0]), 90);
  pages = removePages(pages, keys(pages, [5])); // drop b1
  const out = await PDFDocument.load(await assemblePdf(sources, pages, { title: 'Merged' }), { updateMetadata: false });
  assert.deepEqual(out.getPages().map((p) => p.getWidth()), [150, 100, 101, 101, 102]);
  assert.deepEqual(out.getPages().map((p) => p.getRotation().angle), [90, 0, 0, 0, 0]);
  assert.equal(out.getTitle(), 'Merged');
  assert.equal(out.getProducer(), 'Vibrato');
});

test('pdf assemble: refuses locked sources and empty output', async () => {
  const a = { ...(await source('a', 1)), locked: true };
  await assert.rejects(assemblePdf(new Map([[a.id, a]]), pagesOf(a)), PdfLockedError);
  await assert.rejects(assemblePdf(new Map([[a.id, a]]), []), /No pages/);
  assert.equal(await isEncrypted(await makePdf(1)), false);
});

test('pdf export: file names and canvas-safe scale', () => {
  assert.equal(pageImageName('report', 3, 12, 'png'), 'report-03.png');
  assert.equal(pageImageName('report', 7, 120, 'jpeg'), 'report-007.jpg');
  assert.equal(exportScale(612, 792, 144), 2);
  const s = exportScale(2384, 3370, 600); // A0 at 600 dpi
  assert.ok(2384 * s <= MAX_SIDE && 3370 * s <= MAX_SIDE);
  assert.ok(2384 * 3370 * s * s <= MAX_AREA + 1);
});
