import fs from 'node:fs/promises';
import { startCordisHostDaemon } from './daemon.mjs';

const [, , stateDirectory, socketPath, manifestPath] = process.argv;
if (!stateDirectory || !socketPath || !manifestPath) {
  throw new Error('usage: daemon-runner.mjs <state> <socket> <manifest>');
}
let manifest;
for (;;) {
  manifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
  if (manifest) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const daemon = await startCordisHostDaemon({
  stateDirectory,
  socketPath,
  graphHash: manifest.execution_epoch.graph_hash,
  version: '0.1.0-v4',
  capabilities: ['snapshot', 'heartbeat', 'reconcile', 'shutdown', 'epoch-control'],
  initialBundle: structuredClone(manifest.execution_epoch.candidate),
});
process.once('SIGTERM', async () => {
  await daemon.shutdown();
});
