function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export type DailyResetParseResult =
  | { ok: true; kind: 'local' | 'utc'; hour: number; minute: number }
  | { ok: false; error: string };

export function parseDailyResetTime(input: string | null | undefined): DailyResetParseResult {
  const raw = typeof input === 'string' ? input.trim() : '';
  const value = raw || '12:00';
  const isUtc = value.toUpperCase().endsWith('Z');
  const base = isUtc ? value.slice(0, -1) : value;
  const m = base.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return { ok: false, error: `invalid reset time format: ${value}` };
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, error: `invalid reset time value: ${value}` };
  }
  return { ok: true, kind: isUtc ? 'utc' : 'local', hour, minute };
}

export function computeNextDailyResetAtMs(args: {
  nowMs: number;
  resetTime?: string | null;
}): { resetAtMs: number; resetTimeNormalized: string } {
  const parsed = parseDailyResetTime(args.resetTime);
  const fallback: DailyResetParseResult = { ok: true, kind: 'local', hour: 12, minute: 0 };
  const resolved = parsed.ok ? parsed : fallback;
  const kind = resolved.kind;
  const hour = resolved.hour;
  const minute = resolved.minute;
  const resetTimeNormalized = `${pad2(hour)}:${pad2(minute)}${kind === 'utc' ? 'Z' : ''}`;

  const now = new Date(args.nowMs);
  let candidate: Date;
  if (kind === 'utc') {
    candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
    if (candidate.getTime() <= args.nowMs) {
      candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hour, minute, 0, 0));
    }
  } else {
    candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (candidate.getTime() <= args.nowMs) {
      candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
    }
  }
  return { resetAtMs: candidate.getTime(), resetTimeNormalized };
}

