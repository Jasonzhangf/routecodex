import net from 'node:net';

export async function findOpenPort(start = 3000, end = 3999): Promise<number> {
  for (let port = start; port <= end; port++) {
    const isFree = await checkPort(port);
    if (isFree) {
      return port;
    }
  }
  throw new Error('No available port found');
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      server.close();
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}
