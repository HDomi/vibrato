import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const line = (o: unknown) => JSON.stringify(o) + '\n';

test('history search matches what the user or the agent said, across both CLIs, and follows appended lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-search-'));
  const prev = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  process.env.CODEX_HOME = join(root, 'codex');
  try {
    const proj = join(root, 'claude', 'projects', '-p-app');
    await mkdir(join(proj, 'abc', 'subagents'), { recursive: true });
    const claudeFile = join(proj, 'abc.jsonl');
    await writeFile(claudeFile,
      line({ type: 'user', cwd: '/p/app', message: { role: 'user', content: '<command-name>/clear</command-name> fizzbuzz' } }) +
      line({ type: 'user', cwd: '/p/app', message: { role: 'user', content: 'Fix the login TIMEOUT please' } }) +
      line({ type: 'assistant', cwd: '/p/app', message: { role: 'assistant', content: [{ type: 'text', text: 'The refresh token expires too early.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep quokka' } }] } }) +
      line({ type: 'user', cwd: '/p/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'quokka found in tool output only' }] } }));
    await writeFile(join(proj, 'abc', 'subagents', 'agent-1.jsonl'), line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'timeout from a subagent' }] } }));
    const day = join(root, 'codex', 'sessions', '2026', '11', '04');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, 'rollout-x.jsonl'),
      line({ type: 'session_meta', payload: { id: 'thread-9', cwd: '/p/other', base_instructions: { text: 'timeout policy in a system prompt' } } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>timeout</environment_context>' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Raise the request timeout to 30s' }] } }));

    const { searchHistory } = await import('../server/historySearch');
    const hits = await searchHistory('timeout');
    assert.deepEqual(hits.map((h) => [h.agent, h.sessionId, h.cwd]).sort(), [['claude', 'abc', '/p/app'], ['codex', 'thread-9', '/p/other']]);
    const claude = hits.find((h) => h.agent === 'claude')!;
    assert.equal(claude.title, 'Fix the login TIMEOUT please');
    assert.match(claude.snippet, /login TIMEOUT/);
    assert.equal(hits.find((h) => h.agent === 'codex')!.title, 'Raise the request timeout to 30s');
    assert.deepEqual(await searchHistory('quokka'), [], 'tool output alone is not a hit');
    assert.deepEqual(await searchHistory('fizzbuzz'), [], 'injected command turns are not a hit');
    assert.deepEqual(await searchHistory('a'), [], 'one character is too short to search');

    await appendFile(claudeFile, line({ type: 'assistant', cwd: '/p/app', message: { role: 'assistant', content: [{ type: 'text', text: 'Added a wombat fallback.' }] } }));
    assert.deepEqual((await searchHistory('wombat', 30, 0)).map((h) => h.sessionId), ['abc']);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev.claude; process.env.CODEX_HOME = prev.codex;
    if (prev.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    if (prev.codex === undefined) delete process.env.CODEX_HOME;
    await rm(root, { recursive: true, force: true });
  }
});
