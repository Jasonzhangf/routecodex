/**
 * Server Lifecycle Module
 *
 * Port management, signal handling, and process lifecycle utilities.
 */

export { ensurePortAvailable, killPidBestEffort, canBind, attemptHttpShutdown, resolveSignalCaller } from './port-utils.js';
