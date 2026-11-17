/*
 * Discord webhook notices for the remote host: a client logged in, or wrong codes locked an address.
 * Fire and forget: a slow or failing webhook never holds up or refuses a login.
 * The webhook URL is a secret (anyone holding it can post to the channel): it stays in ~/.vibrato/config.json
 * (owner-only) and the settings screen only ever gets a masked copy.
 */

/** Discord's own webhook endpoints only, so the setting cannot be turned into a request to anywhere else. */
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\/(\d{5,25})\/([\w-]{20,200})$/;

export function validWebhook(url: string): boolean {
  return WEBHOOK_RE.test(url.trim());
}

/** "discord.com/api/webhooks/1234…/abcd••••": enough to recognise it, not enough to use it. */
export function maskWebhook(url: string): string {
  const m = WEBHOOK_RE.exec(url.trim());
  if (!m) return '';
  const host = new URL(url.trim()).host;
  return `${host}/api/webhooks/${m[1].slice(0, 4)}…/${m[2].slice(0, 4)}••••`;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export async function sendDiscord(url: string, content: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  if (!validWebhook(url)) throw new Error('Not a Discord webhook URL.');
  const res = await fetchImpl(url.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_mentions: a host name or address can never ping @everyone.
    body: JSON.stringify({ username: 'Vibrato', content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status}.`);
}

/** YYYY.MM.DD HH:MM in this computer's local time. */
export function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** First line of every Vibrato notice, so consecutive messages stay apart in the channel. */
export const NOTICE_RULE = '-'.repeat(40);

/** Keep peer-controlled text from forming markdown or mentions. */
const plain = (s: string) => s.replace(/[`*_~|>@#[\]()\\]/g, '').slice(0, 100);

/**
 * The notice format: 연결성공 / 연결실패 for every login attempt, 연결중단 when a logged-in client leaves
 * (on purpose, closed by the host, or the link dropped). 접속대상 is this host's name.
 */
export function noticeMessage(o: { kind: 'login' | 'logout'; host: string; address: string; at: number; ok: boolean }): string {
  const state = o.kind === 'logout' ? '연결중단' : o.ok ? '연결성공' : '연결실패';
  return `${NOTICE_RULE}\n[Vibrato Remote]\n\n접속대상: ${hostLabel(o.host)}\nIP: ${plain(o.address) || '-'}\n시간: ${stamp(o.at)}\n연결여부: ${state}`;
}

export function testMessage(host: string): string {
  return `${NOTICE_RULE}\n[Vibrato Remote]\n\n접속대상: ${hostLabel(host)}\n시간: ${stamp(Date.now())}\n연결성공 · 연결실패 · 연결중단을 이 채널로 보냅니다.`;
}

/** "Studio-Mac.local" -> "Studio-Mac". */
const hostLabel = (host: string) => plain(host.replace(/\.local$/i, '')) || '-';
