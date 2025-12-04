import { FileSnapshotStore } from './snapshot-store.js';
import { DebugSessionManager } from './session-manager.js';
import { HarnessRegistry } from './harness-registry.js';
import { createDefaultHarnessRegistry } from './default-harnesses.js';
import type { DefaultHarnessOptions } from './default-harnesses.js';
import { DryRunRunner } from './dry-runner.js';
import { ReplayRunner } from './replay-runner.js';
import type { SnapshotStore } from './types.js';

export interface DebugToolkitOptions extends DefaultHarnessOptions {
  snapshotDirectory?: string;
  store?: SnapshotStore;
  registry?: HarnessRegistry;
}

export function createDebugToolkit(options: DebugToolkitOptions = {}) {
  const store = options.store ?? new FileSnapshotStore(options.snapshotDirectory);
  const sessions = new DebugSessionManager(store);
  const registry = options.registry ?? createDefaultHarnessRegistry({ providerDependencies: options.providerDependencies });
  const dryRunner = new DryRunRunner(sessions, registry);
  const replayRunner = new ReplayRunner(sessions, registry);
  return {
    store,
    sessions,
    registry,
    dryRunner,
    replayRunner
  };
}

export * from './types.js';
export * from './snapshot-store.js';
export * from './session-manager.js';
export * from './dry-runner.js';
export * from './replay-runner.js';
export * from './default-harnesses.js';
