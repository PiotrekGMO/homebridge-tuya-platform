import { describe, expect, test } from '@jest/globals';
import net from 'net';
import { canConnect } from '../src/util/network';

describe('canConnect', () => {
  test('is true for a host that accepts the connection, false when nothing listens or the address is invalid', async () => {
    const server = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    expect(await canConnect(`http://127.0.0.1:${port}`, 2000)).toBe(true);
    await new Promise(resolve => server.close(resolve));
    expect(await canConnect(`http://127.0.0.1:${port}`, 2000)).toBe(false);
    expect(await canConnect('not a url', 2000)).toBe(false);
  });
});
