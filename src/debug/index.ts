import { FileSnapshotStore } from './snapshot-store.js';
import { DebugSessionManager } from './session-manager.js';
import { HarnessRegistry } from './harness/registry.js';
import { createDefaultHarnessRegistry } from './harness/defaults.js';
import type { DefaultHarnessOptions } from './harness/defaults.js';
import { DryRunRunner } from './harness/dry-runner.js';
import { ReplayRunner } from './harness/replay-runner.js';
import {
  readDebugErrorDiagArtifactInternal,
  writeDebugErrorDiagArtifactInternal,
} from './diag/error-artifact.js';
import type { SnapshotStore } from './types.js';
import type { DebugErrorDiagArtifactRecord } from './diag/error-artifact.js';

export interface DebugToolkitOptions extends DefaultHarnessOptions {
  snapshotDirectory?: string;
  store?: SnapshotStore;
  registry?: HarnessRegistry;
}

export function createDebugToolkit(options: DebugToolkitOptions = {}) {
  const store = options.store ?? new FileSnapshotStore(options.snapshotDirectory);
  const sessions = new DebugSessionManager(store);
  const registry = options.registry ?? createDefaultHarnessRegistry(options);
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

export function createDebugSurfaceRegistry(options: DebugToolkitOptions = {}) {
  return createDebugToolkit(options);
}

export async function writeDebugErrorDiagArtifact(input: {
  endpoint: string;
  requestId: string;
  requestBody: unknown;
  error: unknown;
  rootDir?: string;
}): Promise<string> {
  return writeDebugErrorDiagArtifactInternal(input);
}

export async function readDebugErrorDiagArtifact(filePath: string): Promise<DebugErrorDiagArtifactRecord> {
  return readDebugErrorDiagArtifactInternal(filePath);
}

export * from './types.js';
export * from './snapshot-store.js';
export * from './session-manager.js';
export * from './harness/index.js';
export * from './diag/index.js';
export * from './logger/index.js';
export * from './snapshot/index.js';
export * from './hooks/index.js';
export * from './policy/index.js';
