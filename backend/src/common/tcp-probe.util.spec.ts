import { createServer, Server } from 'net';
import { AddressInfo } from 'net';
import { probeTcpPort } from './tcp-probe.util';

describe('probeTcpPort', () => {
  let server: Server;
  let port: number;

  beforeAll((done) => {
    server = createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('resolves true when the port is open', async () => {
    await expect(probeTcpPort('127.0.0.1', port)).resolves.toBe(true);
  });

  it('resolves false when the port is closed', async () => {
    const server2 = createServer();
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const closedPort = (server2.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server2.close(() => resolve()));

    await expect(probeTcpPort('127.0.0.1', closedPort)).resolves.toBe(false);
  });

  it('resolves false on timeout for a non-routable address', async () => {
    await expect(probeTcpPort('10.255.255.1', 12345, 200)).resolves.toBe(false);
  }, 10_000);
});
