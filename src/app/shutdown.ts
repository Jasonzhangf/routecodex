/**
 * Shutdown Handling
 *
 * Process shutdown reason tracking and cleanup.
 */

type ShutdownReason =
  | { kind: 'signal'; signal: string }
  | { kind: 'uncaughtException'; message: string }
  | { kind: 'startupError'; message: string }
  | { kind: 'stopError'; message: string }
  | { kind: 'unknown' };

let lastShutdownReason: ShutdownReason = { kind: 'unknown' };
let restartInProgress = false;
let currentRuntimeLifecyclePath: string | null = null;

function setCurrentRuntimeLifecyclePath(value: string | null): void {
  currentRuntimeLifecyclePath = typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createRuntimeRunId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `run_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function recordShutdownReason(reason: ShutdownReason): void {
  if (lastShutdownReason.kind === 'unknown') {
    lastShutdownReason = reason;
  }
}

function getShutdownReason(): ShutdownReason {
  return lastShutdownReason;
}

function isRestartInProgress(): boolean {
  return restartInProgress;
}

function setRestartInProgress(value: boolean): void {
  restartInProgress = value;
}

function getCurrentRuntimeLifecyclePath(): string | null {
  return currentRuntimeLifecyclePath;
}

export {
  recordShutdownReason,
  getShutdownReason,
  isRestartInProgress,
  setRestartInProgress,
  createRuntimeRunId,
  setCurrentRuntimeLifecyclePath,
  getCurrentRuntimeLifecyclePath,
  lastShutdownReason,
  restartInProgress,
  currentRuntimeLifecyclePath
};

export type { ShutdownReason };
