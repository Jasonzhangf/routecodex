export type {
  HeartbeatConfigSnapshot,
  HeartbeatDispatchResult,
  HeartbeatHistoryEvent,
  HeartbeatState,
} from "./types.js";

export {
  normalizeHeartbeatConfig,
  resolveHeartbeatConfig,
} from "./config.js";

export {
  loadHeartbeatState,
  listHeartbeatStates,
  removeHeartbeatState,
  saveHeartbeatState,
  setHeartbeatEnabled,
} from "./session-store.js";

export {
  appendHeartbeatHistoryEvent,
  listHeartbeatHistory,
} from "./history-store.js";

export {
  DEFAULT_DELIVERY_HISTORY_LIMIT,
  pruneDeliveryLogText,
} from "./delivery-log.js";

export {
  buildHeartbeatInjectText,
  resetHeartbeatRuntimeHooksForTests,
  runHeartbeatDaemonTickForTests,
  setHeartbeatRuntimeHooks,
  startHeartbeatDaemonIfNeeded,
  stopHeartbeatDaemonForTests,
} from "./daemon.js";
