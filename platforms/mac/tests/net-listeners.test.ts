import assert from 'node:assert/strict';
import test from 'node:test';
import { listListeners, parseLsof } from '../server/os/net';

test('lsof parsing', () => {
  const ports = parseLsof('p123\ncnode\nLme\nf20\nn127.0.0.1:5173\nf21\nn[::1]:5173\np9\ncpostgres\nLme\nf5\nn*:5432\nf6\nn*:5432\n');
  assert.deepEqual(ports, [
    { pid: 123, command: 'node', user: 'me', address: '127.0.0.1', port: 5173 },
    { pid: 123, command: 'node', user: 'me', address: '::1', port: 5173 },
    { pid: 9, command: 'postgres', user: 'me', address: '*', port: 5432 },
  ]);
});

test('listeners are read from the running system', async () => {
  for (const p of await listListeners()) assert.ok(Number.isInteger(p.pid) && p.port > 0 && p.port < 65536);
});
