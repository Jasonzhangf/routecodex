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
  lastScheduleDiagnostic?: HeartbeatScheduleDiagnostic;
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

export type HeartbeatSchedulePhase =
  | "triggered"
  | "skipped"
  | "failed"
  | "disabled";

export type HeartbeatCronShadowDiagnostic =
  | {
      supported: true;
      expression: string;
      timezone: string;
      previousBoundaryAtMs: number;
      nextBoundaryAtMs: number;
      offsetFromPreviousBoundaryMs: number;
    }
  | {
      supported: false;
      reason: string;
    };

export type HeartbeatScheduleDiagnostic = {
  phase: HeartbeatSchedulePhase;
  observedAtMs: number;
  daemonScanMs: number;
  effectiveIntervalMs: number;
  anchorAtMs?: number;
  dueAtMs?: number;
  dueInMs?: number;
  latenessMs?: number;
  reason?: string;
  cronShadow: HeartbeatCronShadowDiagnostic;
};

export type HeartbeatHistoryEvent = {
  version: 1;
  atMs: number;
  tmuxSessionId: string;
  source: string;
  action: string;
  outcome: string;
  reason?: string;
  details?: Record<string, unknown>;
};
