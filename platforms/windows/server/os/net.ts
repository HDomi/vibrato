import { run } from '../shell.js';
import type { ListeningPort } from '../net.js';

/* Windows: listening TCP sockets from netstat, process names from tasklist. */

/** `netstat -ano` lines like "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1234" (also [::]:port). */
export function parseNetstat(text: string): { pid: number; address: string; port: number }[] {
  const out: { pid: number; address: string; port: number }[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const raw = m[1].replace(/^\[|\]$/g, '').replace(/%\d+$/, '');
    // The same form lsof gives on macOS: "*" for every interface.
    const address = raw === '0.0.0.0' || raw === '::' ? '*' : raw;
    const pid = Number(m[3]), port = Number(m[2]);
    const key = `${pid}:${address}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, address, port });
  }
  return out.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** `tasklist /FO CSV /NH` lines: "name.exe","1234","Console","1","12,345 K". */
export function parseTasklist(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ''));
  }
  return names;
}

/** Every listening TCP socket with its process. Windows does not tell another process's working directory or user here. */
export async function listListeners(): Promise<Omit<ListeningPort, 'self'>[]> {
  const r = await run('netstat.exe', ['-ano', '-p', 'TCP'], 10000);
  const v6 = await run('netstat.exe', ['-ano', '-p', 'TCPv6'], 10000);
  if (!r.ok && !r.stdout) throw new Error(r.stderr || 'netstat failed');
  const ports = parseNetstat(`${r.stdout}\n${v6.stdout}`);
  const names = ports.length ? parseTasklist((await run('tasklist.exe', ['/FO', 'CSV', '/NH'], 10000)).stdout) : new Map<number, string>();
  return ports.map((p) => ({ ...p, command: names.get(p.pid) ?? '', user: '', cwd: null }));
}
