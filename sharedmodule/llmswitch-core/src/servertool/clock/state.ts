import type {
  ClockConfigSnapshot,
  ClockSessionMeta,
  ClockSessionState,
  ClockTask,
  ClockTaskRecurrence,
  ClockTaskSetter
} from './types.js';

let clockOffsetMs = 0;

const CLOCK_OVERDUE_AUTO_REMOVE_MS = 60_000;

function normalizeRecurrence(raw: unknown): ClockTaskRecurrence | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const rawKind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
  const kind = rawKind === 'daily' || rawKind === 'weekly' || rawKind === 'interval'
    ? rawKind
    : undefined;
  const maxRunsRaw = Number(record.maxRuns);
  const maxRuns = Number.isFinite(maxRunsRaw) ? Math.floor(maxRunsRaw) : NaN;
  if (!kind || !Number.isFinite(maxRuns) || maxRuns <= 0) {
    return undefined;
  }
  if (kind === 'interval') {
    const minutesRaw = Number(record.everyMinutes);
    const everyMinutes = Number.isFinite(minutesRaw) ? Math.floor(minutesRaw) : NaN;
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      return undefined;
    }
    return { kind, maxRuns, everyMinutes };
  }
  return { kind, maxRuns };
}

function normalizeTaskSetter(raw: unknown): ClockTaskSetter {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'agent') {
    return 'agent';
  }
  return 'user';
}

export function setClockOffsetMs(value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  clockOffsetMs = Math.max(-24 * 60 * 60_000, Math.min(24 * 60 * 60_000, Math.floor(value)));
}

export function getClockOffsetMs(): number {
  return clockOffsetMs;
}

export function nowMs(): number {
  return Date.now() + clockOffsetMs;
}

export function buildDefaultClockSessionMeta(): ClockSessionMeta {
  return {
    taskRevision: 0,
    listedRevision: -1
  };
}

export function normalizeClockSessionMeta(raw: unknown): ClockSessionMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return buildDefaultClockSessionMeta();
  }
  const record = raw as Record<string, unknown>;
  const taskRevisionRaw = Number(record.taskRevision);
  const listedRevisionRaw = Number(record.listedRevision);
  const lastListAtMsRaw = Number(record.lastListAtMs);
  return {
    taskRevision:
      Number.isFinite(taskRevisionRaw) && taskRevisionRaw >= 0
        ? Math.floor(taskRevisionRaw)
        : 0,
    listedRevision: Number.isFinite(listedRevisionRaw)
      ? Math.floor(listedRevisionRaw)
      : -1,
    ...(Number.isFinite(lastListAtMsRaw) ? { lastListAtMs: Math.floor(lastListAtMsRaw) } : {})
  };
}

export function buildEmptyState(sessionId: string): ClockSessionState {
  const t = nowMs();
  return { version: 1, sessionId, tasks: [], updatedAtMs: t, meta: buildDefaultClockSessionMeta() };
}

export function coerceState(raw: unknown, sessionId: string): ClockSessionState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return buildEmptyState(sessionId);
  }
  const record = raw as Record<string, unknown>;
  const tasksRaw = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks: ClockTask[] = [];
  for (const entry of tasksRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const taskId = typeof e.taskId === 'string' ? e.taskId.trim() : '';
    const dueAtMs = typeof e.dueAtMs === 'number' && Number.isFinite(e.dueAtMs) ? Math.floor(e.dueAtMs) : NaN;
    const createdAtMs =
      typeof e.createdAtMs === 'number' && Number.isFinite(e.createdAtMs) ? Math.floor(e.createdAtMs) : NaN;
    const updatedAtMs =
      typeof e.updatedAtMs === 'number' && Number.isFinite(e.updatedAtMs) ? Math.floor(e.updatedAtMs) : NaN;
    const task = typeof e.task === 'string' ? e.task.trim() : '';
    const prompt = typeof e.prompt === 'string' && e.prompt.trim() ? e.prompt.trim() : task;
    if (!taskId || !task || !Number.isFinite(dueAtMs) || !Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) {
      continue;
    }
    const tool = typeof e.tool === 'string' && e.tool.trim() ? e.tool.trim() : undefined;
    const args =
      e.arguments && typeof e.arguments === 'object' && !Array.isArray(e.arguments)
        ? (e.arguments as Record<string, unknown>)
        : undefined;
    const deliveredAtMs =
      typeof e.deliveredAtMs === 'number' && Number.isFinite(e.deliveredAtMs) ? Math.floor(e.deliveredAtMs) : undefined;
    const notBeforeRequestId =
      typeof e.notBeforeRequestId === 'string' && e.notBeforeRequestId.trim().length
        ? e.notBeforeRequestId.trim()
        : undefined;
    const deliveryCount =
      typeof e.deliveryCount === 'number' && Number.isFinite(e.deliveryCount) ? Math.max(0, Math.floor(e.deliveryCount)) : 0;
    const urls = Array.isArray(e.urls)
      ? e.urls.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
      : undefined;
    const paths = Array.isArray(e.paths)
      ? e.paths.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
      : undefined;
    const recurrence = normalizeRecurrence(e.recurrence);
    const setBy = normalizeTaskSetter(e.setBy);
    tasks.push({
      taskId,
      sessionId,
      dueAtMs,
      createdAtMs,
      updatedAtMs,
      setBy,
      ...(prompt ? { prompt } : {}),
      task,
      ...(tool ? { tool } : {}),
      ...(args ? { arguments: args } : {}),
      ...(urls && urls.length ? { urls } : {}),
      ...(paths && paths.length ? { paths } : {}),
      ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
      deliveryCount,
      ...(notBeforeRequestId ? { notBeforeRequestId } : {}),
      ...(recurrence ? { recurrence } : {})
    });
  }
  const tmuxSessionId =
    typeof record.tmuxSessionId === 'string' && record.tmuxSessionId.trim()
      ? record.tmuxSessionId.trim()
      : undefined;
  const updatedAtMs =
    typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs) ? Math.floor(record.updatedAtMs) : nowMs();
  const meta = normalizeClockSessionMeta(record.meta);
  return { version: 1, sessionId, ...(tmuxSessionId ? { tmuxSessionId } : {}), tasks, updatedAtMs, meta };
}

export function cleanExpiredTasks(tasks: ClockTask[], config: ClockConfigSnapshot, atMs: number): ClockTask[] {
  const out: ClockTask[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    if (!Number.isFinite(task.dueAtMs)) continue;

    const recurrence = normalizeRecurrence((task as any).recurrence);
    const deliveryCount = typeof task.deliveryCount === 'number' && Number.isFinite(task.deliveryCount)
      ? Math.max(0, Math.floor(task.deliveryCount))
      : 0;

    if (recurrence) {
      if (deliveryCount >= recurrence.maxRuns) {
        continue;
      }
      out.push({ ...task, recurrence });
      continue;
    }

    const oneShotRetentionMs = Math.max(0, Math.min(config.retentionMs, CLOCK_OVERDUE_AUTO_REMOVE_MS));
    if (atMs > task.dueAtMs + oneShotRetentionMs) {
      continue;
    }
    out.push(task);
  }
  return out;
}
