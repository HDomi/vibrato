import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { after } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { attachPty, detachedPtys, killAllPtys } from '../server/pty';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// node-pty's ConPTY worker keeps the process alive after the shells are killed, so this file would never end
// on its own. The server itself exits through process.exit (index.ts shutdown), as this does once the results are out.
after(() => { setTimeout(() => process.exit(), 1000); });

async function listen() {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  attachPty(wss);
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  return { port, close: () => { killAllPtys(); wss.close(); http.close(); } };
}

function open(port: number, query: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?${new URLSearchParams(query)}`);
  const out: string[] = [];
  ws.on('message', (d) => out.push(String(d)));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  return { ws, out, closed, ready: new Promise<void>((r) => ws.on('open', () => r())) };
}

test('a dropped terminal socket keeps its shell and the same tab reattaches with the output it missed (PowerShell)', { skip: process.platform !== 'win32' }, async () => {
  const { port, close } = await listen();
  try {
    const first = open(port, { cwd: process.cwd(), cols: '80', rows: '24', id: 'tab-one', cmd: "Write-Output ('BEFORE-' + 'DROP'); Start-Sleep -Milliseconds 1200; Write-Output ('AFTER-' + 'DROP')" });
    await first.ready;
    for (let i = 0; i < 100 && !first.out.join('').includes('BEFORE-DROP'); i++) await wait(50);
    assert.ok(first.out.join('').includes('BEFORE-DROP'));
    first.ws.close();
    await first.closed;
    await wait(100);
    assert.deepEqual(detachedPtys(), ['tab-one']);
    await wait(1500);
    // Reattach: no new `cmd`, the buffered output arrives, the shell is the same process. (The string concatenation keeps the markers out of the command echo.)
    const second = open(port, { cwd: process.cwd(), cols: '100', rows: '30', id: 'tab-one' });
    await second.ready;
    for (let i = 0; i < 100 && !second.out.join('').includes('AFTER-DROP'); i++) await wait(50);
    assert.ok(second.out.join('').includes('AFTER-DROP'), 'output printed while detached is replayed');
    assert.ok(!second.out.join('').includes('BEFORE-DROP'), 'the initial command is not run again');
    assert.deepEqual(detachedPtys(), []);
    // A deliberate close kills the shell immediately: a later connect with the same id gets a fresh one.
    second.ws.send(JSON.stringify({ type: 'close' }));
    await wait(200);
    second.ws.close();
    await second.closed;
    assert.deepEqual(detachedPtys(), []);
    const third = open(port, { cwd: process.cwd(), cols: '80', rows: '24', id: 'tab-one', cmd: 'exit 3' });
    await third.ready;
    assert.equal(await third.closed, 4000, 'process exit closes with the no-reconnect code');
    assert.ok(third.out.join('').includes('[process exited 3]'));
  } finally { close(); }
});
