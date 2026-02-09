interface ShutdownCallerContext {
  source: string;
  requestTs: string;
  remoteIp?: string;
  method?: string;
  path?: string;
  userAgent?: string;
  forwardedFor?: string;
  origin?: string;
  referer?: string;
  authPresent?: boolean;
  callerPid?: string;
  callerTs?: string;
  callerCwd?: string;
  callerCmd?: string;
}

const DEFAULT_MAX_AGE_MS = 120_000;

let cached: { value: ShutdownCallerContext; setAtMs: number } | null = null;

export function setShutdownCallerContext(value: ShutdownCallerContext): void {
  cached = {
    value: { ...value },
    setAtMs: Date.now()
  };
}

export function clearShutdownCallerContext(): void {
  cached = null;
}

export function getShutdownCallerContext(opts?: { maxAgeMs?: number }): ShutdownCallerContext | null {
  if (!cached) {
    return null;
  }
  const maxAgeMs = Number.isFinite(opts?.maxAgeMs) && (opts?.maxAgeMs as number) > 0
    ? Number(opts?.maxAgeMs)
    : DEFAULT_MAX_AGE_MS;
  if (Date.now() - cached.setAtMs > maxAgeMs) {
    cached = null;
    return null;
  }
  return { ...cached.value };
}

export type { ShutdownCallerContext };
