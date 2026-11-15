import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { shimTarget, startable } from '../server/os/shell';
import { parseNetstat, parseTasklist, listListeners } from '../server/os/net';
import { parsePowerSource, readPowerSource } from '../server/os/power';
import { icoFromPng } from '../server/os/images';
import { isReleasePackage, bundleOf } from '../server/os/update';
import { keyLabel, STRINGS } from '../web/src/platform/strings';

// Everything that needs a real Windows is skipped elsewhere: `npm run test:win` on a Mac still checks the parsers.
const windows = { skip: process.platform !== 'win32' };

test('npm .cmd shims resolve to the script or executable they run', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const text = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  assert.equal(shimTarget(text, shim), 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
  assert.equal(shimTarget('"%~dp0\\node_modules\\x\\bin\\x.exe" %*', shim), 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\x\\bin\\x.exe');
  assert.equal(shimTarget('@echo nothing here', shim), null);
  assert.deepEqual(startable('C:\\x\\cli.js', ['--version']), { file: process.execPath, args: ['C:\\x\\cli.js', '--version'] });
  assert.deepEqual(startable('C:\\x\\claude.exe', ['--version']), { file: 'C:\\x\\claude.exe', args: ['--version'] });
});

test('netstat and tasklist output is parsed into listeners', () => {
  const out = '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1128\r\n  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9012\r\n  TCP    192.168.0.5:50000      1.2.3.4:443            ESTABLISHED     77\r\n  TCP    [::]:135               [::]:0                 LISTENING       1128\r\n  TCP    [::1]:5173             [::]:0                 LISTENING       9012\r\n';
  assert.deepEqual(parseNetstat(out), [
    { pid: 1128, address: '*', port: 135 },
    { pid: 9012, address: '127.0.0.1', port: 5173 },
    { pid: 9012, address: '::1', port: 5173 },
  ]);
  const names = parseTasklist('"svchost.exe","1128","Services","0","12,345 K"\r\n"node.exe","9012","Console","1","88,000 K"\r\n');
  assert.equal(names.get(1128), 'svchost');
  assert.equal(names.get(9012), 'node');
});

test('power line status, release package names, icon container, shortcut labels', () => {
  assert.equal(parsePowerSource('Online'), 'ac');
  assert.equal(parsePowerSource('Offline\r\n'), 'battery');
  assert.equal(parsePowerSource('Unknown'), null);
  assert.equal(isReleasePackage('Vibrato-Setup-5.3.0-x64.exe', 'x64'), true);
  assert.equal(isReleasePackage('Vibrato-Setup-5.3.0-x64.exe', 'arm64'), false);
  assert.equal(isReleasePackage('Vibrato-5.3.0-win-x64.zip', 'x64'), false);
  assert.equal(isReleasePackage('Vibrato-5.3.0-arm64-mac.zip', 'arm64'), false);
  assert.equal(bundleOf('C:\\src\\vibrato'), null);
  const ico = icoFromPng(Buffer.from('PNGDATA'), 256);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt8(6), 0, '256px is stored as 0');
  assert.equal(ico.readUInt32LE(14), 7);
  assert.equal(ico.subarray(22).toString(), 'PNGDATA');
  assert.equal(keyLabel('⇧⌘N'), 'Ctrl+Shift+N');
  assert.equal(keyLabel('⌘⌫'), 'Ctrl+Backspace');
  assert.equal(keyLabel('Copy (⌘C/⌘X/⌘V)'), 'Copy (Ctrl+C/Ctrl+X/Ctrl+V)');
  assert.equal(keyLabel('⌥←'), 'Alt+←');
  assert.equal(keyLabel('plain'), 'plain');
  assert.deepEqual(Object.keys(STRINGS.ko).filter((k) => !(k in STRINGS.en)), [], 'every Korean override has an English one');
});

/** A valid 4x2 RGBA PNG, built by hand so the test needs no fixture file. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x80)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('shell: command lines run through cmd.exe, CLIs are found, a tree is stopped', windows, async () => {
  const { run, streamShell, which } = await import('../server/shell');
  const lines: string[] = [];
  assert.equal(await streamShell('echo one& echo two 1>&2& exit /b 4', (l, s) => lines.push(`${s}:${l.trim()}`)), 4);
  assert.deepEqual(lines.sort(), ['stderr:two', 'stdout:one']);
  const node = await which('node');
  assert.ok(node && /node\.exe$/i.test(node), String(node));
  assert.match((await run(node!, ['-p', '1+1'])).stdout, /^2$/);
  assert.equal(await which('surely-not-a-command-xyz'), null);
  const started = Date.now();
  assert.equal(await streamShell('ping -n 30 127.0.0.1 >nul', () => {}, 1500), 124);
  assert.ok(Date.now() - started < 15000);
});

test('images: probe, convert and render through GDI+', windows, async () => {
  const { convertImage, imageInfo, renderPng } = await import('../server/image');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibrato-img-'));
  try {
    const src = path.join(dir, 'a.png');
    await fs.writeFile(src, png(4, 2));
    assert.deepEqual(await imageInfo(src), { width: 4, height: 2, format: 'png', hasAlpha: true });
    const jpg = await convertImage({ path: src, dest: path.join(dir, 'b.jpg'), format: 'jpeg', width: 8, height: 4, quality: 80 });
    assert.deepEqual({ ...(await imageInfo(jpg)), hasAlpha: undefined }, { width: 8, height: 4, format: 'jpeg', hasAlpha: undefined });
    const ico = await convertImage({ path: src, dest: path.join(dir, 'c.ico'), format: 'ico', width: 32, height: 32 });
    const bytes = await fs.readFile(ico);
    assert.equal(bytes.readUInt8(6), 32);
    assert.equal(bytes.subarray(22, 26).toString('latin1'), '\x89PNG');
    assert.equal((await renderPng(src, { fit: 16 })).subarray(1, 4).toString(), 'PNG');
    await assert.rejects(convertImage({ path: src, dest: path.join(dir, 'd.heic'), format: 'heic' }), /Unsupported format/);
    await assert.rejects(imageInfo(path.join(dir, 'missing.png')), /Not a readable image/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['a.png', 'b.jpg', 'c.ico'], 'no temporary files left');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('files: zip with the folder as top entry, Recycle Bin', windows, async () => {
  const { zipFolder, moveToTrash, SYSTEM_TAR } = await import('../server/os/files');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibrato-files-'));
  try {
    await fs.mkdir(path.join(dir, 'pack', 'images'), { recursive: true });
    await fs.writeFile(path.join(dir, 'pack', 'pack.md'), '# hi');
    await fs.writeFile(path.join(dir, 'pack', 'images', 'x.txt'), 'x');
    const zip = path.join(dir, 'pack.zip');
    assert.equal((await zipFolder(path.join(dir, 'pack'), zip)).ok, true);
    const { run } = await import('../server/shell');
    const listing = (await run(SYSTEM_TAR, ['-tf', zip])).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.ok(listing.includes('pack/pack.md') && listing.includes('pack/images/x.txt'), listing.join(' '));
    const gone = path.join(dir, 'gone.txt');
    await fs.writeFile(gone, 'bye');
    // A service session (CI) may have no Recycle Bin; then the call must reject and leave the file alone.
    const moved = await moveToTrash([gone]).then(() => true, () => false);
    assert.equal(await fs.access(gone).then(() => true, () => false), !moved);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('system reads: listeners, power source, clipboard files, openssl, privacy', windows, async () => {
  for (const p of await listListeners()) assert.ok(Number.isInteger(p.pid) && p.port > 0 && p.port < 65536, JSON.stringify(p));
  assert.ok([null, 'ac', 'battery'].includes(await readPowerSource()));
  const { opensslPath } = await import('../server/os/programs');
  assert.match(await opensslPath(), /openssl\.exe$/i);
  const { privacySnapshot } = await import('../server/os/privacy');
  assert.equal((await privacySnapshot()).tcc, null);
  const { readClipboardFiles, writeClipboardFiles } = await import('../server/os/clipboard');
  const file = path.join(os.tmpdir(), `vibrato-clip-${process.pid}.txt`);
  await fs.writeFile(file, 'clip');
  try {
    // A session without a clipboard (CI service) rejects; with one, what was written is read back.
    const wrote = await writeClipboardFiles([file]).catch(() => null);
    if (wrote) {
      const read = await readClipboardFiles();
      assert.equal(read.change, wrote.change);
      assert.deepEqual(read.paths.map((p) => p.toLowerCase()), [file.toLowerCase()]);
    }
  } finally { await fs.rm(file, { force: true }); }
});
