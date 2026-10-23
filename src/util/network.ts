import net from 'net';

/** Whether a TCP connection to the host of `url` (https by default) can be opened within the timeout. */
export function canConnect(url: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      resolve(false);
      return;
    }

    const port = Number(target.port) || (target.protocol === 'http:' ? 80 : 443);
    const socket = net.createConnection({ host: target.hostname, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
