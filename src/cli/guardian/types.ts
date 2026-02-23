export type GuardianState = {
  pid: number;
  port: number;
  token: string;
  stopToken: string;
  startedAt: string;
  updatedAt: string;
};

export type GuardianRegistration = {
  source: string;
  pid: number;
  ppid: number;
  port?: number;
  tmuxSessionId?: string;
  tmuxTarget?: string;
  metadata?: Record<string, unknown>;
};

export type GuardianStopResult = {
  requested: boolean;
  stopped: boolean;
  reason: string;
};

export type GuardianLifecycleEvent = {
  action: string;
  source: string;
  actorPid: number;
  targetPid?: number;
  signal?: string;
  metadata?: Record<string, unknown>;
};
