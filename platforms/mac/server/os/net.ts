import { run } from '../shell.js';
import type { ListeningPort } from '../net.js';

/* macOS: listening TCP sockets and their owners from lsof. */

/** Parses `lsof -F pcLn` output. */
export function parseLsof(text: string): Omit<ListeningPort, 'cwd' | 'self'>[] {
  const out: Omit<ListeningPort, 'cwd' | 'self'>[] = [];
  const seen = new Set<string>();
  let pid = 0, command = '', user = '';
  for (const line of text.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = Number(val); command = ''; user = ''; }
    else if (tag === 'c') command = val;
    else if (tag === 'L') user = val;
    else if (tag === 'n') {
      const m = /^(.*):(\d+)$/.exec(val);
      if (!m) continue;
      const address = m[1].replace(/^\[|\]$/g, ''), port = Number(m[2]);
      const key = `${pid}:${address}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, user, address, port });
    }
  }
  return out.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** Every listening TCP socket with its process and, where readable, that process's working directory. */
export async function listListeners(): Promise<Omit<ListeningPort, 'self'>[]> {
  const r = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcLn'], 10000);
  // lsof exits 1 when nothing matches; only treat it as an error when there is no output at all.
  if (!r.ok && !r.stdout) { if (/permission|not permitted/i.test(r.stderr)) throw new Error(r.stderr); return []; }
  const ports = parseLsof(r.stdout);
  const pids = [...new Set(ports.map((p) => p.pid))];
  const cwd = new Map<number, string>();
  if (pids.length) {
    const c = await run('/usr/sbin/lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'], 10000);
    let cur = 0;
    for (const line of c.stdout.split('\n')) {
      if (line[0] === 'p') cur = Number(line.slice(1));
      else if (line[0] === 'n' && cur) cwd.set(cur, line.slice(1));
    }
  }
  return ports.map((p) => ({ ...p, cwd: cwd.get(p.pid) ?? null }));
}
