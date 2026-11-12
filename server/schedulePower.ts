import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

/**
 * Power side of scheduled runs.
 * - Awake: `caffeinate -i -s` stops idle sleep (and, on AC power, system sleep) while a run is near or
 *   running. It never stops lid-close or Apple-menu sleep. `-w` ties it to this process.
 * - Wake: a sleeping Mac only wakes for a power event scheduled with `pmset schedule wake`, which needs root.
 *   The user installs, once and with an admin prompt, a root-owned helper that does exactly that and a
 *   sudoers rule allowing only that helper. The helper takes an epoch time, so the rule cannot be used to
 *   run pmset with anything else.
 */

export const HELPER_PATH = '/Library/PrivilegedHelperTools/com.hdomi.vibrato.wake';
export const SUDOERS_PATH = '/etc/sudoers.d/vibrato';
const OWNER_BASE = 'Vibrato';
/** An unchanged wake target is checked against `pmset -g sched` at most this often (someone may have cleared it). */
const RESYNC_MS = 5 * 60 * 1000;

/** The helper installed as root. Arguments: set|cancel <epoch seconds> <tag>. */
export const HELPER_SCRIPT = `#!/bin/sh
# Installed by Vibrato. Schedules or cancels the app's own wake events and nothing else;
# the sudoers rule in ${SUDOERS_PATH} lets the app run it without a password.
set -eu
[ "$#" -eq 3 ] || exit 64
case "$1" in set|cancel) ;; *) exit 64 ;; esac
case "$2" in ''|*[!0-9]*) exit 64 ;; esac
[ "\${#2}" -le 11 ] || exit 64
case "$3" in ''|*[!A-Za-z0-9]*) exit 64 ;; esac
[ "\${#3}" -le 16 ] || exit 64
when=$(/bin/date -r "$2" '+%m/%d/%y %H:%M:%S')
if [ "$1" = set ]; then exec /usr/bin/pmset schedule wake "$when" "${OWNER_BASE}.$3"; fi
exec /usr/bin/pmset schedule cancel wake "$when" "${OWNER_BASE}.$3"
`;

export function sudoersRule(user: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) throw new Error(`Unsupported user name "${user}"`);
  return `# Vibrato: schedule the app's own wake events (see ${HELPER_PATH}).\n${user} ALL=(root) NOPASSWD: ${HELPER_PATH}\n`;
}

/** Wake events this app (tag) scheduled, from `pmset -g sched`, as epoch ms. */
export function parseOwnWakes(out: string, tag: string): number[] {
  const owner = `${OWNER_BASE}.${tag}`;
  const times: number[] = [];
  for (const m of out.matchAll(/\bwake at (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}) by '([^']*)'/g)) {
    if (m[7] !== owner) continue;
    times.push(new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime());
  }
  return times;
}

function exec(file: string, args: string[], timeout = 15000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(file, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) })));
}

export interface PowerStatus { helper: boolean; awake: boolean; wakeAt: number | null; error: string | null }

export class SchedulePower {
  private child: ChildProcess | null = null;
  private helper: boolean | null = null;
  private wakes: number[] = [];
  private error: string | null = null;
  private syncing: Promise<void> = Promise.resolve();
  /** pmset was read at least once; with no wake wanted and none of ours pending, later syncs skip it. */
  private checked = false;
  /** The wake time (epoch ms, whole seconds) the last successful sync left in place, and when. */
  private synced: { want: number; at: number } | null = null;

  /** `tag` keeps a test copy of the app (another port) from cancelling the real app's wake events. */
  constructor(private tag: string, private enabled = process.platform === 'darwin') {}

  status(): PowerStatus {
    return { helper: !!this.helper, awake: !!this.child, wakeAt: this.wakes.length ? Math.min(...this.wakes) : null, error: this.error };
  }

  holdAwake(on: boolean) {
    if (!this.enabled) return;
    if (on && !this.child) {
      const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
      child.on('error', (err) => { console.warn(`[vibrato] caffeinate failed: ${err.message}`); if (this.child === child) this.child = null; });
      child.on('exit', () => { if (this.child === child) this.child = null; });
      this.child = child;
    } else if (!on && this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  async helperInstalled(refresh = false): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.helper === null || refresh) {
      // -l with a command only checks the policy; -n fails instead of prompting when a password would be needed.
      const r = await exec('/usr/bin/sudo', ['-n', '-l', HELPER_PATH, 'set', '0', this.tag], 5000);
      this.helper = r.ok;
    }
    return this.helper;
  }

  /** Make the app's scheduled wake events exactly `[target]` (or none). Serialized; cheap when nothing changes. */
  syncWake(target: number | null): Promise<void> {
    const job = this.syncing.then(() => this.doSync(target));
    this.syncing = job.catch(() => {});
    return job;
  }

  private async doSync(target: number | null) {
    if (!this.enabled) return;
    if (target === null && this.checked && this.wakes.length === 0) { this.error = null; return; }
    const want = target === null ? null : Math.floor(target / 1000) * 1000;
    // Same wake as last time, recently confirmed: the scheduler asks every tick, pmset need not be read every tick.
    if (want !== null && this.synced?.want === want && Date.now() - this.synced.at < RESYNC_MS && this.error === null) return;
    this.synced = null;
    const sched = await exec('/usr/bin/pmset', ['-g', 'sched'], 5000);
    if (!sched.ok) return;
    this.checked = true;
    const own = parseOwnWakes(sched.stdout, this.tag);
    this.wakes = own;
    if (want === null ? own.length === 0 : own.length === 1 && own[0] === want) { this.error = null; if (want !== null) this.synced = { want, at: Date.now() }; return; }
    if (!(await this.helperInstalled())) {
      this.error = want === null ? null : 'helper-missing';
      return;
    }
    const run = (op: 'set' | 'cancel', t: number) => exec('/usr/bin/sudo', ['-n', HELPER_PATH, op, String(Math.floor(t / 1000)), this.tag]);
    for (const t of own) if (t !== want) await run('cancel', t);
    if (want !== null && !own.includes(want)) {
      const r = await run('set', want);
      if (!r.ok) {
        this.error = r.stderr.trim().split('\n').pop() || 'pmset failed';
        // The rule may have been removed outside the app; check again next time.
        this.helper = null;
        return;
      }
    }
    this.error = null;
    this.wakes = want === null ? [] : [want];
    if (want !== null) this.synced = { want, at: Date.now() };
  }

  /** Install (or remove) the helper and sudoers rule behind one admin password prompt. */
  async setHelper(install: boolean, prompt: string): Promise<'ok' | 'cancelled'> {
    if (!this.enabled) throw new Error('Waking the Mac is only available on macOS');
    let cmd: string;
    let dir: string | null = null;
    if (install) {
      dir = await fs.mkdtemp(path.join(tmpdir(), 'vibrato-wake-'));
      const script = path.join(dir, 'helper.sh');
      const rule = path.join(dir, 'sudoers');
      await fs.writeFile(script, HELPER_SCRIPT, { mode: 0o600 });
      await fs.writeFile(rule, sudoersRule(userInfo().username), { mode: 0o600 });
      cmd = [
        `/usr/sbin/visudo -cf '${rule}'`,
        `/bin/mkdir -p /Library/PrivilegedHelperTools`,
        `/usr/bin/install -o root -g wheel -m 0755 '${script}' '${HELPER_PATH}'`,
        `/usr/bin/install -o root -g wheel -m 0440 '${rule}' '${SUDOERS_PATH}'`,
      ].join(' && ');
    } else {
      // Cancel our pending wakes while the rule still allows it.
      await this.syncWake(null).catch(() => {});
      cmd = `/bin/rm -f '${SUDOERS_PATH}' '${HELPER_PATH}'`;
    }
    try {
      const r = await exec('/usr/bin/osascript', [
        '-e', 'on run argv', '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges', '-e', 'end run',
        cmd, prompt,
      ], 120000);
      if (!r.ok) {
        if (/-128|User canceled/i.test(r.stderr)) return 'cancelled';
        throw new Error(r.stderr.trim().split('\n').pop() || 'Admin command failed');
      }
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
    await this.helperInstalled(true);
    this.error = null;
    return 'ok';
  }

  stop() { this.holdAwake(false); }
}
