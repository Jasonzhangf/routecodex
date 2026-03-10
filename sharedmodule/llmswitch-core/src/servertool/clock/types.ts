export type ClockRecurrenceKind = 'daily' | 'weekly' | 'interval';

export type ClockTaskRecurrence = {
  kind: ClockRecurrenceKind;
  maxRuns: number;
  everyMinutes?: number;
};

export type ClockTaskSetter = 'user' | 'agent';

export type ClockTask = {
  taskId: string;
  sessionId: string;
  dueAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  setBy: ClockTaskSetter;
  prompt?: string;
  task: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  urls?: string[];
  paths?: string[];
  deliveredAtMs?: number;
  deliveryCount: number;
  notBeforeRequestId?: string;
  recurrence?: ClockTaskRecurrence;
};

export type ClockSessionMeta = {
  taskRevision: number;
  listedRevision: number;
  lastListAtMs?: number;
};

export type ClockSessionState = {
  version: 1;
  sessionId: string;
  tmuxSessionId?: string;
  tasks: ClockTask[];
  updatedAtMs: number;
  meta?: ClockSessionMeta;
};

export type ClockReservation = {
  reservationId: string;
  sessionId: string;
  taskIds: string[];
  reservedAtMs: number;
};

export type ClockConfigSnapshot = {
  enabled: boolean;
  retentionMs: number;
  dueWindowMs: number;
  tickMs: number;
  /**
   * Whether clock_hold_flow is allowed for non-streaming (JSON) clients.
   * Default: true (best-effort long-poll hold; clients can abort the connection).
   */
  holdNonStreaming: boolean;
  /**
   * Maximum time (ms) a single request is allowed to hold before followup.
   * Default: 60s. Larger values increase resource usage and risk client/proxy timeouts.
   */
  holdMaxMs: number;
};

export type ClockScheduleItem = {
  dueAtMs: number;
  prompt?: string;
  task: string;
  setBy?: ClockTaskSetter;
  tool?: string;
  arguments?: Record<string, unknown>;
  urls?: string[];
  paths?: string[];
  notBeforeRequestId?: string;
  recurrence?: ClockTaskRecurrence;
};

export type ClockTaskUpdatePatch = {
  dueAtMs?: number;
  prompt?: string;
  task?: string;
  tool?: string | null;
  arguments?: Record<string, unknown> | null;
  urls?: string[] | null;
  paths?: string[] | null;
  notBeforeRequestId?: string | null;
  recurrence?: ClockTaskRecurrence | null;
  resetDelivery?: boolean;
};

export type ClockNtpState = {
  version: 1;
  offsetMs: number;
  updatedAtMs: number;
  source?: string;
  rttMs?: number;
  status: 'synced' | 'stale' | 'error' | 'disabled';
  lastError?: string;
};
