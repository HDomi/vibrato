import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolve source and compiled entrypoints without treating any ancestor named dist as special. */
function findRoot(start: string): string {
  let current = start;
  while (true) {
    try {
      if (JSON.parse(readFileSync(path.join(current, 'package.json'), 'utf8')).name === 'vibrato') return current;
    } catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Vibrato repository root not found');
    current = parent;
  }
}

/** VIBRATO_REPO_ROOT: set when the server runs from a staged copy of the sources (scripts/platform.cjs dev, serve). */
export const REPO_ROOT = process.env.VIBRATO_REPO_ROOT || findRoot(path.dirname(fileURLToPath(import.meta.url)));
