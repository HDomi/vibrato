import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  assemblePdf, baseName, duplicatePages, exportScale, IMAGE_MARGIN, imagePageLayout, imagePdf, isEncrypted, isImageName, jpegOrientation,
  MAX_AREA, MAX_SIDE, movePages, nudgePages, pageImageName, pagesOf, PdfLockedError, removePages, rotatePages, sniff, type PageRef, type PdfSource,
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

/** A real (tiny) RGB PNG, so pdf-lib's embedPng has something to parse. */
function png(w: number, h: number): Uint8Array {
  const crc = (buf: Buffer) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** JPEG header bytes with an EXIF orientation tag (enough for the parser; not a decodable image). */
function exifJpeg(orientation: number, littleEndian: boolean): Uint8Array {
  const u16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (littleEndian ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1, 0xff, 0xda, 0, 2]);
}

test('pdf images: signatures and EXIF orientation', () => {
  assert.equal(sniff(png(1, 1)), 'png');
  assert.equal(sniff(new TextEncoder().encode('%PDF-1.7')), 'pdf');
  assert.equal(sniff(exifJpeg(1, true)), 'jpeg');
  assert.equal(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null);
  assert.equal(jpegOrientation(exifJpeg(6, true)), 6);
  assert.equal(jpegOrientation(exifJpeg(8, false)), 8);
  assert.equal(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
  assert.equal(jpegOrientation(png(1, 1)), 1);
  assert.ok(isImageName('IMG_0001.HEIC') && isImageName('a.jpeg') && !isImageName('a.pdf'));
  assert.equal(baseName('photo.jpg'), 'photo');
  assert.equal(baseName('report.final.pdf'), 'report.final');
});

test('pdf images: page layout and one-page PDF', async () => {
  assert.deepEqual(imagePageLayout(800, 600, 'image'), { page: [600, 450], x: 0, y: 0, width: 600, height: 450 });
  const a4 = imagePageLayout(4000, 3000, 'a4'); // landscape photo → landscape A4, fitted inside the margin
  assert.deepEqual(a4.page, [841.89, 595.28]);
  assert.ok(Math.abs(a4.width / a4.height - 4 / 3) < 1e-9);
  assert.ok(a4.x >= IMAGE_MARGIN - 1e-9 && a4.y >= IMAGE_MARGIN - 1e-9);
  const small = imagePageLayout(100, 200, 'letter'); // small images are not blown up
  assert.deepEqual([small.width, small.height, small.page], [75, 150, [612, 792]]);
  assert.ok(Math.abs(small.x - (612 - 75) / 2) < 1e-9);

  const doc = await PDFDocument.load(await imagePdf(png(40, 20), 'png', 'image', 'pic'), { updateMetadata: false });
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()], [30, 15]);
  assert.equal(doc.getTitle(), 'pic');
  // Image pages merge with PDF pages like any other source.
  const img: PdfSource = { id: 'i', name: 'pic.png', bytes: await imagePdf(png(40, 20), 'png', 'a4'), pageCount: 1, locked: false };
  const a = await source('a', 1);
  const out = await PDFDocument.load(await assemblePdf(new Map([[a.id, a], [img.id, img]]), [...pagesOf(img), ...pagesOf(a)]));
  assert.deepEqual(out.getPages().map((p) => Math.round(p.getWidth())), [842, 100]);
});
