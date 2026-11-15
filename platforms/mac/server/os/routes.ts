import type { Hono } from 'hono';
import { lockBeat, type LockBeat } from '../lockWatch.js';

/** HTTP routes only this target has. */
export function registerOsRoutes(app: Hono) {
  // Lock screen failsafe (see lockWatch.ts). Only the Electron main process calls this; pages always send an Origin.
  app.post('/api/lock-watch', async (c) => {
    if (c.req.header('origin')) return c.json({ ok: false }, 403);
    return c.json(lockBeat(await c.req.json<LockBeat>().catch(() => ({ active: false }))));
  });
}
