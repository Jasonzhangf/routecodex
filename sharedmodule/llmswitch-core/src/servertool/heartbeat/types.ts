export type HeartbeatState = {
  version: 1;
  tmuxSessionId: string;
  enabled: boolean;
  updatedAtMs: number;
  triggerCount: number;
  intervalMs?: number;
  lastTriggeredAtMs?: number;
  lastSkippedAtMs?: number;
  lastSkippedReason?: string;
  lastError?: string;
};

export type HeartbeatConfigSnapshot = {
  tickMs: number;
};

export type HeartbeatDispatchResult = {
  ok: boolean;
  skipped?: boolean;
  disable?: boolean;
  reason?: string;
};
