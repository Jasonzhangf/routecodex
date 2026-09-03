import { startCordisHostDaemon } from '../../src/daemon.mjs';
import fs from 'node:fs/promises';

const [, , stateDirectory, socketPath, mode, value] = process.argv;
let daemon;
if (mode === 'manifest') {
  const manifestPath = value;
  let manifest;
  for (;;) {
    manifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
    if (manifest) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const bundle = structuredClone(manifest.execution_epoch.candidate);
  daemon = await startCordisHostDaemon({
    stateDirectory,
    socketPath,
    graphHash: manifest.execution_epoch.graph_hash,
    version: '0.1.0',
    capabilities: ['snapshot', 'heartbeat', 'reconcile', 'shutdown', 'epoch-control'],
    initialBundle: bundle,
  });
} else {
  daemon = await startCordisHostDaemon({
    stateDirectory,
    socketPath,
    graphHash: value,
    version: '0.1.0',
    capabilities: ['snapshot', 'heartbeat', 'reconcile', 'shutdown'],
  });
}
process.once('SIGTERM', async () => {
  await daemon.shutdown();
});
