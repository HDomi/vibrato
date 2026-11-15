import fs from 'node:fs/promises';
import { FsError } from '../fs.js';
import { powershell } from './powershell.js';

/**
 * Image conversion through GDI+ (System.Drawing in Windows PowerShell): reads PNG, JPEG, GIF, BMP, TIFF and ICO, and
 * writes the formats below. It does not read WebP, HEIC, AVIF or SVG. An .ico is one PNG in an icon container,
 * assembled here. WebP is written by the client (`writeImageBytes`).
 */
export const WRITE_FORMATS: Record<string, { lossy?: boolean }> = {
  png: {}, jpeg: { lossy: true }, tiff: {}, gif: {}, bmp: {}, ico: {},
};
/** No .icns writer on this target. */
export const ICNS_SIZES: number[] = [];

export interface ImageProbe { width: number; height: number; format: string; hasAlpha: boolean }

const LOAD = `Add-Type -AssemblyName System.Drawing; $src=[System.Drawing.Image]::FromFile($env:VIBRATO_SRC)`;
const PROBE = `${LOAD}; try {
  $f=[System.Drawing.Imaging.ImageFormat]; $name='unknown'
  foreach ($n in 'Png','Jpeg','Gif','Bmp','Tiff','Icon') { if ($src.RawFormat.Equals($f::$n)) { $name=$n.ToLower() } }
  $alpha=[System.Drawing.Image]::IsAlphaPixelFormat($src.PixelFormat)
  "$($src.Width) $($src.Height) $name $alpha"
} finally { $src.Dispose() }`;
const ENCODE = `${LOAD}; try {
  $w=$src.Width; $h=$src.Height
  if ($env:VIBRATO_W -and $env:VIBRATO_H) { $w=[int]$env:VIBRATO_W; $h=[int]$env:VIBRATO_H }
  elseif ($env:VIBRATO_FIT) {
    $s=[double]$env:VIBRATO_FIT/[Math]::Max($src.Width,$src.Height)
    $w=[Math]::Max(1,[int][Math]::Round($src.Width*$s)); $h=[Math]::Max(1,[int][Math]::Round($src.Height*$s))
  }
  $bmp=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $g=[System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      if ($env:VIBRATO_FMT -eq 'Jpeg' -or $env:VIBRATO_FMT -eq 'Bmp') { $g.Clear([System.Drawing.Color]::White) }
      $g.DrawImage($src,0,0,$w,$h)
    } finally { $g.Dispose() }
    if ($env:VIBRATO_FMT -eq 'Jpeg') {
      $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $ep=New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]$env:VIBRATO_Q)
      $bmp.Save($env:VIBRATO_OUT,$codec,$ep)
    } else { $bmp.Save($env:VIBRATO_OUT,[System.Drawing.Imaging.ImageFormat]::($env:VIBRATO_FMT)) }
  } finally { $bmp.Dispose() }
} finally { $src.Dispose() }`;

/** Size and format of an image file, or null when it is not a readable image. */
export async function probeImage(abs: string): Promise<ImageProbe | null> {
  const r = await powershell(PROBE, { VIBRATO_SRC: abs });
  const m = /^(\d+) (\d+) (\w+) (True|False)$/m.exec(r.stdout);
  if (!r.ok || !m || !Number(m[1]) || !Number(m[2])) return null;
  return { width: Number(m[1]), height: Number(m[2]), format: m[3] === 'icon' ? 'ico' : m[3], hasAlpha: m[4] === 'True' };
}

/** An .ico file holding one PNG (Windows Vista and later read PNG entries; 256px is stored as 0). */
export function icoFromPng(png: Buffer, size: number): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);                    // type: icon, one image
  head.writeUInt8(size >= 256 ? 0 : size, 6); head.writeUInt8(size >= 256 ? 0 : size, 7);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);                 // planes, bits per pixel
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);        // size and offset of the PNG
  return Buffer.concat([head, png]);
}

const GDI_NAME: Record<string, string> = { png: 'Png', jpeg: 'Jpeg', tiff: 'Tiff', gif: 'Gif', bmp: 'Bmp', ico: 'Png' };

/** Write `src` as `format` to `out`: exact `width` x `height`, or scaled so its longer side is `fit`. */
export async function encodeImage(src: string, out: string, format: string, opts: { width?: number; height?: number; quality?: number; fit?: number }) {
  const name = GDI_NAME[format];
  if (!name) throw new FsError('ECONVERT', `Could not convert to ${format}`, 422);
  const env: Record<string, string> = { VIBRATO_SRC: src, VIBRATO_OUT: out, VIBRATO_FMT: name, VIBRATO_Q: String(Math.round(Math.min(100, Math.max(1, opts.quality ?? 90)))) };
  if (opts.width && opts.height) { env.VIBRATO_W = String(opts.width); env.VIBRATO_H = String(opts.height); }
  else if (opts.fit) env.VIBRATO_FIT = String(opts.fit);
  const r = await powershell(ENCODE, env, 120000);
  const size = await fs.stat(out).then((s) => s.size).catch(() => 0);
  if (!r.ok || !size) {
    await fs.rm(out, { force: true });
    throw new FsError('ECONVERT', `Could not convert to ${format}${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`, 422);
  }
  if (format === 'ico') await fs.writeFile(out, icoFromPng(await fs.readFile(out), opts.width ?? opts.fit ?? 256));
}
