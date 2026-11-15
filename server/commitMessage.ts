import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolvePath } from './fs.js';
import { startable, which } from './shell.js';

/**
 * Commit message for the staged changes, written by the user's own CLI (Claude, else Codex) in one
 * tool-less turn. The repository's instruction files and recent subjects are passed in so the message
 * follows its conventions (language, type prefixes, no co-author trailers when they say so).
 */

const MAX_DIFF = 60000;
const MAX_RULES = 6000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ''))));
}

export async function commitPrompt(cwd: string): Promise<string | null> {
  const [diff, stat, log] = await Promise.all([
    git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff']),
    git(cwd, ['diff', '--cached', '--stat']),
    git(cwd, ['log', '-12', '--format=%s']),
  ]);
  if (!diff.trim()) return null;
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || cwd;
  const rules: string[] = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const text = await fs.readFile(path.join(top, f), 'utf8').catch(() => '');
    if (text.trim()) rules.push(`--- ${f} ---\n${text.slice(0, MAX_RULES)}`);
  }
  const body = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated; full stat above)` : diff;
  return [
    'Write the git commit message for the staged changes below.',
    'Follow the conventions in the repository instructions and match the style (language, prefix, length) of the recent commit subjects.',
    'Output only the commit message itself: a subject line (aim for 50 characters, no trailing period), then optionally a blank line and a short body that explains why, wrapped at 72 characters.',
    'No code fences, no quotes around it, no explanations, and no Co-Authored-By or "Generated with" lines.',
    rules.length ? `\nRepository instructions:\n${rules.join('\n\n')}` : '',
    `\nRecent commit subjects:\n${log.trim() || '(none)'}`,
    `\nStaged changes (stat):\n${stat.trim()}`,
    `\nStaged diff:\n${body}`,
  ].join('\n');
}

/** Strip what models add around a message despite being told not to. */
export function cleanMessage(text: string): string {
  return text.trim().replace(/^```[\w-]*\n?|\n?```$/g, '').replace(/^["'](.*)["']$/s, '$1')
    .split('\n').filter((l) => !/^(co-authored-by|generated with|🤖)/i.test(l.trim())).join('\n').trim();
}

async function viaClaude(claudePath: string, cwd: string, prompt: string): Promise<string> {
  const q = query({ prompt, options: { pathToClaudeCodeExecutable: claudePath, cwd, model: 'haiku', tools: [], settingSources: [], maxTurns: 1, persistSession: false, env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'vibrato/0.1.0' } } });
  const timer = setTimeout(() => void q.interrupt().catch(() => {}), 60000);
  try {
    for await (const m of q) {
      if (m.type === 'result') {
        if (m.subtype !== 'success') throw new Error(`Claude could not write a message (${m.subtype})`);
        return m.result;
      }
    }
    throw new Error('Claude returned no message');
  } finally { clearTimeout(timer); }
}

async function viaCodex(codexPath: string, cwd: string, prompt: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'vibrato-msg-'));
  const out = path.join(dir, 'last.txt');
  try {
    await new Promise<void>((resolve, reject) => {
      const start = startable(codexPath, ['exec', '--skip-git-repo-check', '-s', 'read-only', '--output-last-message', out, '-']);
      const child = execFile(start.file, start.args, { cwd, timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
      child.stdin?.end(prompt);
    });
    return await fs.readFile(out, 'utf8');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export async function suggestCommitMessage(dir: string): Promise<{ message: string; agent: 'claude' | 'codex' }> {
  const cwd = resolvePath(dir);
  const prompt = await commitPrompt(cwd);
  if (!prompt) throw Object.assign(new Error('Nothing is staged'), { code: 'NOTHING_STAGED' });
  const claude = await which('claude');
  if (claude) return { message: cleanMessage(await viaClaude(claude, cwd, prompt)), agent: 'claude' };
  const codex = await which('codex');
  if (codex) return { message: cleanMessage(await viaCodex(codex, cwd, prompt)), agent: 'codex' };
  throw new Error('Neither claude nor codex CLI is installed');
}
