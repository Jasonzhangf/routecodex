import { startCordisHostDaemon } from '../../src/daemon.mjs';

const [, , stateDirectory, socketPath, graphHash] = process.argv;
const daemon = await startCordisHostDaemon({
  stateDirectory,
  socketPath,
  graphHash,
  version: '0.1.0',
  capabilities: ['snapshot', 'heartbeat', 'reconcile', 'shutdown'],
});
process.once('SIGTERM', async () => {
  await daemon.shutdown();
});
