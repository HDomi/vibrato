import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFileName, exportMarkdown } from '../web/src/lib/exportMarkdown';
import type { ChatItem } from '../web/src/lib/chatStore';

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Fix the bug', attachments: [{ path: '/tmp/shot.png', name: 'shot.png', kind: 'image' }, { path: '/tmp/log.txt', name: 'log.txt', kind: 'file' }] },
  { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' }, output: 'ok ```inline``` done\n[image]\n', isError: false, parent: null, elapsed: 1, done: true, images: ['data:image/png;base64,AAAA'] },
  { kind: 'assistant', id: 'a-sub', text: 'sub result', thinking: '', parent: 't1', streaming: false },
  { kind: 'assistant', id: 'a1', text: 'Done.\n\n## Notes\n- one', thinking: 'secret', parent: null, streaming: false },
  { kind: 'assistant', id: 'a2', text: '', thinking: '', parent: null, streaming: true },
  { kind: 'result', id: 'r1', ok: true, text: '', costUsd: 0.5, turnCostUsd: 0.0123, numTurns: 2, durationMs: 4200 },
  { kind: 'changes', id: 'c1', root: '/p', from: 'x', to: 'y', files: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1, binary: false }] },
];

test('export keeps only picked top-level blocks, nests tool children, and names images', () => {
  const { markdown, images } = exportMarkdown(items, new Set(['u1', 't1', 'a1', 'a2']), { title: 'My session', agent: 'Claude', cwd: '/p', date: '2026-10-28' });
  assert.match(markdown, /^# My session\n\nClaude · \/p · 2026-10-28/);
  assert.match(markdown, /\*\*User\*\*\n\nFix the bug\n\n!\[shot.png\]\(images\/001-shot.png\)\n\n📎 `log.txt`/);
  assert.match(markdown, /<summary>🔧 Bash · npm test<\/summary>/);
  assert.match(markdown, /\*\*Output\*\*\n\n````\nok ```inline``` done\n````/); // fence longer than inner backticks, [image] line dropped
  assert.match(markdown, /!\[Bash\]\(images\/002-bash.png\)/);
  assert.match(markdown, /\*\*Claude\*\* \(subagent\)\n\nsub result/);
  assert.match(markdown, /\*\*Claude\*\*\n\nDone\.\n\n## Notes/);
  assert.ok(!markdown.includes('secret'), 'thinking is off by default');
  assert.ok(!markdown.includes('Done ·'), 'unpicked result block is left out');
  assert.ok(!markdown.includes('a.ts'), 'unpicked changes block is left out');
  assert.deepEqual(images, [{ name: 'images/001-shot.png', src: '/tmp/shot.png' }, { name: 'images/002-bash.png', src: 'data:image/png;base64,AAAA' }]);
});

test('thinking can be included and the same image source is bundled once', () => {
  const twice: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'a', attachments: [{ path: '/tmp/shot.png', name: 'shot.png', kind: 'image' }] },
    { kind: 'user', id: 'u2', text: 'b', attachments: [{ path: '/tmp/shot.png', name: 'shot.png', kind: 'image' }] },
    { kind: 'assistant', id: 'a1', text: 'x', thinking: 'why', parent: null, streaming: false },
  ];
  const { markdown, images } = exportMarkdown(twice, new Set(['u1', 'u2', 'a1']), { title: '', agent: 'Codex', cwd: '/p', includeThinking: true });
  assert.equal(images.length, 1);
  assert.match(markdown, /^# Session/);
  assert.match(markdown, /<summary>Thinking<\/summary>\n\nwhy/);
});

test('export file names drop separators and control characters', () => {
  assert.equal(exportFileName(' fix: a/b\\c:d*e?f"g<h>i|j\n '), 'fix a b c d e f g h i j');
  assert.equal(exportFileName('...'), 'session');
  assert.equal(exportFileName(null, 'x'), 'x');
  assert.equal(exportFileName('a'.repeat(100)).length, 80);
});
