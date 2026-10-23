import net from 'net';
import os from 'os';

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

/** The IPv4 addresses of the local /24 networks (at most 1024 per interface) with the given TCP port open. */
export async function scanLan(port: number, timeoutMs = 800, concurrency = 64): Promise<string[]> {
  const targets: string[] = [];
  const own = new Set<string>();
  Object.values(os.networkInterfaces()).forEach(list => list?.forEach(info => {
    if (info.family !== 'IPv4' || info.internal) {
      return;
    }
    own.add(info.address);
    const [a, b, c] = info.address.split('.').map(Number);
    // docker bridges and other virtual networks are not scanned
    if (!(a === 192 && b === 168) && !(a === 10) && !(a === 172 && b >= 16 && b <= 31)) {
      return;
    }
    for (let host = 1; host < 255; host++) {
      targets.push(`${a}.${b}.${c}.${host}`);
    }
  }));

  const found: string[] = [];
  const queue = [...new Set(targets)].filter(ip => !own.has(ip));
  const worker = async () => {
    for (let ip = queue.pop(); ip !== undefined; ip = queue.pop()) {
      if (await canConnect(`tcp://${ip}:${port}`, timeoutMs)) {
        found.push(ip);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort();
}
