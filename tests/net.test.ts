import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { killProcess, netInfo, proxyHttp } from '../server/net';
import { contains, parseSubnet } from '../web/src/lib/toolbox/cidr';

async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('HTTP proxy: method, headers, body echo, gzip, binary, redirects, errors', async () => {
  await withServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/echo') {
        const out = zlib.gzipSync(JSON.stringify({ method: req.method, x: req.headers['x-test'], ua: req.headers['user-agent'], body: Buffer.concat(chunks).toString() }));
        res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Set-Cookie': ['a=1', 'b=2'] }).end(out);
      } else if (u.pathname === '/bin') res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
      else if (u.pathname === '/go') res.writeHead(303, { Location: '/echo' }).end();
      else if (u.pathname === '/slow') setTimeout(() => res.end('late'), 3000);
      else res.writeHead(404).end('nope');
    });
  }, async (base) => {
    const r = await proxyHttp({ method: 'PUT', url: `${base}/echo`, headers: [['X-Test', 'yes']], body: '{"a":1}' });
    assert.ok(r.ok);
    assert.equal(r.status, 201);
    assert.equal(r.encoding, 'utf8');
    assert.deepEqual(JSON.parse(r.body), { method: 'PUT', x: 'yes', ua: 'vibrato', body: '{"a":1}' });
    assert.ok(r.wireSize < r.size || r.size < 80);
    assert.deepEqual(r.headers.filter(([k]) => k === 'Set-Cookie').map(([, v]) => v), ['a=1', 'b=2']);

    const b = await proxyHttp({ method: 'GET', url: `${base}/bin` });
    assert.ok(b.ok && b.encoding === 'base64' && Buffer.from(b.body, 'base64').length === 5);

    const noFollow = await proxyHttp({ method: 'POST', url: `${base}/go`, body: 'x' });
    assert.ok(noFollow.ok && noFollow.status === 303);
    const follow = await proxyHttp({ method: 'POST', url: `${base}/go`, body: 'x', followRedirects: true });
    assert.ok(follow.ok);
    assert.equal(follow.status, 201);
    assert.deepEqual(follow.redirects.map((h) => h.status), [303]);
    assert.equal(JSON.parse(follow.body).method, 'GET');

    const slow = await proxyHttp({ method: 'GET', url: `${base}/slow`, timeoutMs: 1000 });
    assert.ok(!slow.ok && slow.code === 'ETIMEDOUT');
  });
  const bad = await proxyHttp({ method: 'GET', url: 'file:///etc/passwd' });
  assert.ok(!bad.ok && /http/.test(bad.error));
  const refused = await proxyHttp({ method: 'GET', url: 'http://127.0.0.1:1/' });
  assert.ok(!refused.ok && refused.code === 'ECONNREFUSED');
});

test('net info, kill guard', () => {
  const info = netInfo();
  assert.ok(info.hostname && info.interfaces.some((i) => i.internal));
  assert.throws(() => killProcess(process.pid, false), /itself/);
  assert.throws(() => killProcess(1, false), /Invalid/);
});

test('CIDR: subnet facts, masks, edge prefixes, membership', () => {
  const s = parseSubnet('192.168.10.37/20');
  assert.deepEqual([s.network, s.broadcast, s.mask, s.wildcard, s.first, s.last, s.hosts, s.kind], ['192.168.0.0', '192.168.15.255', '255.255.240.0', '0.0.15.255', '192.168.0.1', '192.168.15.254', 4094, 'private']);
  assert.equal(parseSubnet('10.1.2.3 255.255.255.0').prefix, 24);
  assert.equal(parseSubnet('8.8.8.8').hosts, 1);
  assert.deepEqual([parseSubnet('10.0.0.0/31').hosts, parseSubnet('10.0.0.0/31').last], [2, '10.0.0.1']);
  assert.equal(parseSubnet('0.0.0.0/0').total, 2 ** 32);
  assert.equal(parseSubnet('100.70.1.1/32').kind, 'cgnat');
  assert.ok(contains(s, '192.168.15.200'));
  assert.ok(!contains(s, '192.168.16.1'));
  assert.throws(() => parseSubnet('300.1.1.1/8'), /IPv4/);
  assert.throws(() => parseSubnet('1.1.1.1 255.0.255.0'), /contiguous/);
});
