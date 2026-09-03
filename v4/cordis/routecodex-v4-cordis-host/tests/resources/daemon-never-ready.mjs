import net from 'node:net';
import fs from 'node:fs';
import process from 'node:process';

const [, , stateRoot, socketPath] = process.argv;
fs.mkdirSync(stateRoot, { recursive: true });
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer(() => {});
server.listen(socketPath);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
