/**
 * Ephemeral port allocator.
 * Opens a temporary TCP server bound to port 0, records the OS-assigned port,
 * closes the server, and returns the port number.  The caller should use the
 * port immediately; a race is theoretically possible but acceptable for tests.
 */

import * as net from 'node:net';

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}
