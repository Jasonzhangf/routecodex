/**
 * App Module
 *
 * Application-level utilities for shutdown handling and config reading.
 */

export {
  recordShutdownReason,
  getShutdownReason,
  isRestartInProgress,
  setRestartInProgress,
  createRuntimeRunId,
  setCurrentRuntimeLifecyclePath,
  getCurrentRuntimeLifecyclePath
} from './shutdown.js';

export {
  asRecord,
  getNestedRecord,
  readNumber,
  readString,
  readBoolean,
  readRecordNumber,
  readRecordString,
  readRecordBoolean,
  truncateLogValue,
  collectEnvHints
} from './config-readers.js';

export type { ShutdownReason } from './shutdown.js';
export type { UnknownRecord } from './config-readers.js';
