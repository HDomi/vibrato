/**
 * Planets for the intro starfield: each one is painted once into its own canvas (lit sphere, bands, craters,
 * atmosphere glow, optional ring split into a back and a front half) and stamped every frame.
 */

export interface PlanetSpec {
  /** Resting place as a fraction of the viewport, and radius as a fraction of its shorter side. */
  fx: number; fy: number; r: number;
  /** Surface colour, then stripes across it (gas giants) and darker spots (craters). */
  base: string;
  bands?: { y: number; h: number; color: string }[];
  spots?: { x: number; y: number; r: number }[];
  /** Atmosphere glow around the disc. */
  glow: string;
  ring?: { tilt: number; inner: number; outer: number; color: string };
  /** Tilt of the bands, in radians. */
  tilt?: number;
  /** Parallax against the pointer (0..1) and the slow float: amplitude in px, period in seconds. */
  depth: number; float: number; period: number;
}

export const PLANETS: PlanetSpec[] = [
  {
    fx: 0.14, fy: 0.26, r: 0.064, base: '#c08a66', tilt: -0.38, glow: 'rgb(255 190 140 / .2)',
    bands: [
      { y: -0.62, h: 0.14, color: 'rgb(240 205 165 / .55)' },
      { y: -0.32, h: 0.2, color: 'rgb(120 72 52 / .45)' },
      { y: -0.02, h: 0.12, color: 'rgb(235 195 150 / .5)' },
      { y: 0.2, h: 0.24, color: 'rgb(150 92 66 / .4)' },
      { y: 0.52, h: 0.12, color: 'rgb(230 190 150 / .4)' },
    ],
    ring: { tilt: -0.38, inner: 1.38, outer: 2.2, color: '232 205 175' },
    depth: 0.55, float: 7, period: 23,
  },
  {
    fx: 0.86, fy: 0.75, r: 0.04, base: '#3a86ad', tilt: 0.25, glow: 'rgb(110 200 255 / .26)',
    bands: [
      { y: -0.45, h: 0.18, color: 'rgb(140 215 235 / .35)' },
      { y: 0.05, h: 0.12, color: 'rgb(30 80 120 / .4)' },
      { y: 0.35, h: 0.16, color: 'rgb(120 200 225 / .3)' },
    ],
    depth: 0.4, float: 5, period: 31,
  },
  {
    fx: 0.79, fy: 0.16, r: 0.017, base: '#968cb2', glow: 'rgb(190 170 255 / .16)',
    spots: [{ x: -0.3, y: -0.2, r: 0.22 }, { x: 0.25, y: 0.3, r: 0.16 }, { x: 0.35, y: -0.35, r: 0.1 }],
    depth: 0.22, float: 4, period: 19,
  },
];

export interface PlanetSprite {
  spec: PlanetSpec;
  /** Disc radius in CSS px; the sprite is `size` px square, centred on the planet. */
  radius: number; size: number;
  back: HTMLCanvasElement | null;
  front: HTMLCanvasElement;
}

const RING_FLAT = 0.26;

function layer(size: number, dpr: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(size * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return [c, ctx];
}

/** Half of the ring: the far half (behind the disc) or the near one (in front of it). */
function drawRing(ctx: CanvasRenderingContext2D, c: number, R: number, ring: NonNullable<PlanetSpec['ring']>, far: boolean) {
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(ring.tilt);
  ctx.scale(1, RING_FLAT);
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const rr = R * (ring.inner + (ring.outer - ring.inner) * t);
    // Denser in the middle with a thin gap, fading at both edges.
    const a = (0.12 + 0.38 * Math.sin(Math.PI * t)) * (Math.abs(t - 0.62) < 0.05 ? 0.25 : 1) * (far ? 0.75 : 1);
    ctx.strokeStyle = `rgb(${ring.color} / ${a})`;
    ctx.lineWidth = (R * (ring.outer - ring.inner)) / steps + 0.6;
    ctx.beginPath();
    ctx.arc(0, 0, rr, far ? Math.PI : 0, far ? Math.PI * 2 : Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}

export function makePlanetSprite(spec: PlanetSpec, viewW: number, viewH: number, dpr: number): PlanetSprite {
  const R = Math.max(6, Math.min(viewW, viewH) * spec.r);
  const size = Math.ceil(2 * Math.max(R * 1.6, spec.ring ? R * spec.ring.outer + 4 : 0));
  const c = size / 2;

  const [front, f] = layer(size, dpr);
  // Atmosphere: a soft halo just outside the disc.
  const atm = f.createRadialGradient(c, c, R * 0.92, c, c, R * 1.55);
  atm.addColorStop(0, spec.glow);
  atm.addColorStop(1, 'rgb(0 0 0 / 0)');
  f.fillStyle = atm;
  f.fillRect(0, 0, size, size);

  // Disc: base colour, bands and craters, then the light from the upper left and the night side.
  f.save();
  f.beginPath(); f.arc(c, c, R, 0, Math.PI * 2); f.clip();
  f.fillStyle = spec.base;
  f.fillRect(c - R, c - R, R * 2, R * 2);
  if (spec.bands) {
    f.save();
    f.translate(c, c); f.rotate(spec.tilt ?? 0);
    for (const b of spec.bands) { f.fillStyle = b.color; f.fillRect(-R * 1.5, b.y * R, R * 3, b.h * R); }
    f.restore();
  }
  for (const s of spec.spots ?? []) {
    f.fillStyle = 'rgb(40 30 60 / .35)';
    f.beginPath(); f.arc(c + s.x * R, c + s.y * R, s.r * R, 0, Math.PI * 2); f.fill();
  }
  const lx = c - R * 0.45, ly = c - R * 0.5;
  const shade = f.createRadialGradient(lx, ly, R * 0.1, lx, ly, R * 1.75);
  shade.addColorStop(0, 'rgb(0 0 0 / 0)');
  shade.addColorStop(0.45, 'rgb(0 0 0 / .25)');
  shade.addColorStop(0.8, 'rgb(2 3 10 / .82)');
  shade.addColorStop(1, 'rgb(2 3 10 / .95)');
  f.fillStyle = shade;
  f.fillRect(c - R, c - R, R * 2, R * 2);
  const shine = f.createRadialGradient(lx, ly, 0, lx, ly, R * 0.8);
  shine.addColorStop(0, 'rgb(255 255 255 / .28)');
  shine.addColorStop(1, 'rgb(255 255 255 / 0)');
  f.fillStyle = shine;
  f.fillRect(c - R, c - R, R * 2, R * 2);
  f.restore();

  let back: HTMLCanvasElement | null = null;
  if (spec.ring) {
    const [b, bctx] = layer(size, dpr);
    drawRing(bctx, c, R, spec.ring, true);
    back = b;
    drawRing(f, c, R, spec.ring, false);
  }
  return { spec, radius: R, size, back, front };
}
