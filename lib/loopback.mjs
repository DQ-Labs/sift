import http from 'node:http';

const ipv6Unavailable = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT']);

export async function listenLoopback(handler, port, { createServer = http.createServer, log = console.log } = {}) {
  const servers = [];
  async function listen(host) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready);
      server.listen({ port, host, ...(host === '::1' ? { ipv6Only: true } : {}) });
    });
    servers.push(server);
  }
  try {
    await listen('127.0.0.1');
    try { await listen('::1'); } catch (error) {
      if (!ipv6Unavailable.has(error.code)) throw error;
      log('IPv6 loopback is unavailable; use the IPv4 address shown below.');
    }
  } catch (error) {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    throw error;
  }
  return servers;
}
