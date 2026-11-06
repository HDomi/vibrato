import { useEffect, useRef } from 'react';
import { makePlanetSprite, PLANETS, type PlanetSprite } from './planets';

/**
 * Intro backdrop: a dense field of twinkling stars drifting slowly sideways, and a few planets floating in
 * front of it. Stars near the pointer are pushed away and spring back to their place once it has passed;
 * the planets shift a little against the pointer (parallax). One canvas, redrawn per animation frame while
 * the window is visible; with reduced motion everything is drawn once and stays put.
 */

interface Star {
  /** Resting place (drifts slowly) and current position / velocity, in CSS pixels. */
  hx: number; hy: number; x: number; y: number; vx: number; vy: number;
  /** Depth 0..1: nearer stars are bigger, brighter, drift faster and react more. */
  z: number;
  r: number; alpha: number; phase: number; speed: number; color: string;
}

/** Planet parallax: pixels per pixel of pointer offset from the centre, at depth 1. */
const PARALLAX = 0.035;

const COLORS = ['255 255 255', '255 255 255', '214 228 255', '190 210 255', '255 236 214'];
/** Pointer influence radius, push strength, pull back to the resting place, and velocity damping per 60 Hz frame. */
const RADIUS = 170;
const PUSH = 5;
const SPRING = 0.011;
const DAMP = 0.9;

function makeStars(w: number, h: number): Star[] {
  const n = Math.round(Math.min(6000, Math.max(900, (w * h) / 400)));
  const stars = Array.from({ length: n }, () => {
    // Mostly faint, distant dust; a few near, bright stars.
    const z = Math.random() ** 2.6;
    const x = Math.random() * w;
    const y = Math.random() * h;
    return {
      hx: x, hy: y, x, y, vx: 0, vy: 0, z,
      r: 0.35 + z * 1.25 + (Math.random() < 0.03 ? 0.7 : 0),
      alpha: 0.32 + z * 0.62 + Math.random() * 0.12,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 1.8,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  });
  // Grouped by colour so a frame changes the fill only a handful of times.
  return stars.sort((a, b) => (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));
}

/**
 * `fps` caps the redraw rate (the app's wallpaper runs all day, the intro only briefly). `pauseInactive` holds the
 * last frame while the window is not focused.
 */
export default function Starfield({ className = '', fps = 60, pauseInactive = false }: { className?: string; fps?: number; pauseInactive?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0, h = 0;
    let stars: Star[] = [];
    let planets: PlanetSprite[] = [];
    const pointer = { x: -1e4, y: -1e4 };
    /** Smoothed pointer offset from the centre, for the planets' parallax. */
    const lean = { x: 0, y: 0 };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const nw = Math.max(1, rect.width), nh = Math.max(1, rect.height);
      // Keep the stars on a resize, scaled into the new size; make them on the first one.
      if (stars.length && w && h) for (const s of stars) { s.hx *= nw / w; s.x *= nw / w; s.hy *= nh / h; s.y *= nh / h; }
      else stars = makeStars(nw, nh);
      w = nw; h = nh;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      planets = PLANETS.map((p) => makePlanetSprite(p, w, h, dpr));
    };

    // Soft glow around the bright stars: one radial gradient drawn once, then stamped per star.
    const halo = document.createElement('canvas');
    halo.width = halo.height = 64;
    const hctx = halo.getContext('2d')!;
    const grad = hctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgb(220 230 255 / .55)');
    grad.addColorStop(0.35, 'rgb(200 215 255 / .14)');
    grad.addColorStop(1, 'rgb(200 215 255 / 0)');
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 64, 64);

    const draw = (time: number) => {
      ctx.clearRect(0, 0, w, h);
      let fill = '';
      for (const s of stars) {
        const twinkle = still ? 1 : 0.62 + 0.38 * Math.sin(time * 0.001 * s.speed + s.phase);
        // A star still moving from a push glows a little brighter.
        const glow = Math.min(0.45, Math.hypot(s.vx, s.vy) * 0.12);
        const a = Math.min(1, s.alpha * twinkle + glow);
        if (s.r > 1.25) {
          const g = s.r * 5;
          ctx.globalAlpha = a * 0.5;
          ctx.drawImage(halo, s.x - g, s.y - g, g * 2, g * 2);
        }
        if (s.color !== fill) { fill = s.color; ctx.fillStyle = `rgb(${fill})`; }
        ctx.globalAlpha = a;
        // Dust is too small for a round shape to show; a square is much cheaper to fill.
        if (s.r < 0.9) ctx.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
        else { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.globalAlpha = 1;
      for (const p of planets) {
        const { spec } = p;
        const bob = still ? 0 : Math.sin((time / 1000 / spec.period) * Math.PI * 2 + spec.fx * 10) * spec.float;
        const x = spec.fx * w - lean.x * PARALLAX * spec.depth - p.size / 2;
        const y = spec.fy * h + bob - lean.y * PARALLAX * spec.depth - p.size / 2;
        if (p.back) ctx.drawImage(p.back, x, y, p.size, p.size);
        ctx.drawImage(p.front, x, y, p.size, p.size);
      }
    };

    const step = (dt: number) => {
      const r2 = RADIUS * RADIUS;
      const damp = DAMP ** dt;
      const away = pointer.x < -1e3;
      const k = 1 - 0.96 ** dt;
      lean.x += ((away ? 0 : pointer.x - w / 2) - lean.x) * k;
      lean.y += ((away ? 0 : pointer.y - h / 2) - lean.y) * k;
      for (const s of stars) {
        // Slow sideways drift of the resting place, wrapping at the edge (the star jumps along with it).
        const drift = (0.02 + s.z * 0.09) * dt;
        s.hx += drift; s.x += drift;
        if (s.hx > w + 6) { s.hx -= w + 12; s.x -= w + 12; }
        const dx = s.x - pointer.x, dy = s.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2) {
          const d = Math.sqrt(d2) || 1;
          const f = (1 - d / RADIUS) ** 2 * PUSH * (0.55 + s.z * 0.9) * dt;
          s.vx += (dx / d) * f; s.vy += (dy / d) * f;
        }
        s.vx += (s.hx - s.x) * SPRING * dt; s.vy += (s.hy - s.y) * SPRING * dt;
        s.vx *= damp; s.vy *= damp;
        s.x += s.vx * dt; s.y += s.vy * dt;
      }
    };

    resize();
    let raf = 0;
    let last = 0;
    const minGap = 1000 / fps - 2;
    const paused = () => document.hidden || (pauseInactive && !document.hasFocus());
    const frame = (time: number) => {
      raf = 0;
      if (paused()) return;
      if (!last || time - last >= minGap) {
        const dt = last ? Math.min(3, (time - last) / (1000 / 60)) : 1;
        last = time;
        step(dt);
        draw(time);
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf && !paused()) { last = 0; raf = requestAnimationFrame(frame); } };

    const onMove = (e: PointerEvent) => { pointer.x = e.clientX - canvas.getBoundingClientRect().left; pointer.y = e.clientY - canvas.getBoundingClientRect().top; };
    const onLeave = () => { pointer.x = -1e4; pointer.y = -1e4; };
    // Resizing clears the canvas: redraw at once, also while paused.
    const onResize = () => { resize(); draw(still ? 0 : performance.now()); };
    window.addEventListener('resize', onResize);
    if (still) { draw(0); return () => window.removeEventListener('resize', onResize); }
    window.addEventListener('pointermove', onMove);
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    window.addEventListener('focus', start);
    document.addEventListener('visibilitychange', start);
    // The first frame is drawn even when starting unfocused, so the backdrop is never empty.
    draw(0);
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('focus', start);
      document.removeEventListener('visibilitychange', start);
    };
  }, [fps, pauseInactive]);

  return <canvas ref={ref} className={`block w-full h-full ${className}`} aria-hidden />;
}
