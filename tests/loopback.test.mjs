import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { listenLoopback } from '../lib/loopback.mjs';

function factory(failIPv6) {
  const created = [];
  return { created, createServer: () => {
    const server = new EventEmitter(); created.push(server);
    server.listen = options => { server.options = options; queueMicrotask(() => options.host === '::1' && failIPv6 ? server.emit('error', Object.assign(new Error(failIPv6), { code: failIPv6 })) : server.emit('listening')); };
    server.close = callback => { server.closed = true; callback(); };
    return server;
  } };
}

test('local listening binds both explicit loopback addresses without exposing other interfaces', async () => {
  const { createServer } = factory();
  const servers = await listenLoopback(() => {}, 4317, { createServer });
  assert.deepEqual(servers.map(s => s.options), [{ port: 4317, host: '127.0.0.1' }, { port: 4317, host: '::1', ipv6Only: true }]);
});

test('IPv6-disabled systems keep the IPv4 listener available', async () => {
  const { createServer } = factory('EAFNOSUPPORT'), messages = [];
  const servers = await listenLoopback(() => {}, 4317, { createServer, log: message => messages.push(message) });
  assert.equal(servers.length, 1); assert.equal(servers[0].options.host, '127.0.0.1'); assert.match(messages[0], /IPv6 loopback is unavailable/);
});

test('an occupied IPv6 port fails startup and closes the IPv4 listener', async () => {
  const { createServer, created } = factory('EADDRINUSE');
  await assert.rejects(listenLoopback(() => {}, 4317, { createServer }), { code: 'EADDRINUSE' });
  assert.equal(created[0].closed, true);
});
