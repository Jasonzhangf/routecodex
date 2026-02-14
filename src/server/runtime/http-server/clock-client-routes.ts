import type { Application, Request, Response } from 'express';

import {
  cancelClockTaskSnapshot,
  clearClockTasksSnapshot,
  listClockSessionIdsSnapshot,
  listClockTasksSnapshot,
  resolveClockConfigSnapshot,
  scheduleClockTasksSnapshot,
  updateClockTaskSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { getClockClientRegistry } from './clock-client-registry.js';
import { isLocalRequest } from './daemon-admin-routes.js';
import { isTmuxSessionAlive, killManagedTmuxSession } from './tmux-session-probe.js';
import { terminateManagedClientProcess } from './managed-process-probe.js';

type ClockRecurrenceInput = {
  kind: 'daily' | 'weekly' | 'interval';
  maxRuns: number;
  everyMinutes?: number;
};

function parseString(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed || undefined;
}

function parseBoolean(input: unknown): boolean | undefined {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return undefined;
}

function isClockManagedTerminationEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_CLOCK_REAPER_TERMINATE_MANAGED
      ?? process.env.RCC_CLOCK_REAPER_TERMINATE_MANAGED
      ?? ''
  ).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return false;
}

function parsePositiveInt(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parseIsoToMs(input: unknown): number | null {
  if (typeof input !== 'string') {
    return null;
  }
  const parsed = Date.parse(input.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function parseRecurrenceKind(raw: unknown): 'daily' | 'weekly' | 'interval' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) {
    return undefined;
  }
  if (value === 'daily' || value === 'day') {
    return 'daily';
  }
  if (value === 'weekly' || value === 'week') {
    return 'weekly';
  }
  if (value === 'interval' || value === 'every_minutes' || value === 'every-minutes' || value === 'everyminutes') {
    return 'interval';
  }
  return undefined;
}

function parseRecurrenceInput(input: unknown, fallbackRecord?: Record<string, unknown>): { recurrence?: ClockRecurrenceInput; error?: string } {
  if (input === undefined || input === null || input === false) {
    return {};
  }

  let kind: 'daily' | 'weekly' | 'interval' | undefined;
  let maxRunsRaw: unknown;
  let everyMinutesRaw: unknown;

  if (typeof input === 'string') {
    kind = parseRecurrenceKind(input);
    maxRunsRaw = fallbackRecord?.maxRuns;
    everyMinutesRaw = fallbackRecord?.everyMinutes;
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    kind = parseRecurrenceKind(rec.kind ?? rec.type ?? rec.mode ?? rec.every);
    maxRunsRaw = rec.maxRuns ?? fallbackRecord?.maxRuns;
    everyMinutesRaw = rec.everyMinutes ?? rec.minutes ?? fallbackRecord?.everyMinutes;
  }

  if (!kind) {
    return { error: 'recurrence kind must be daily|weekly|interval' };
  }

  const maxRunsNum = Number(maxRunsRaw);
  const maxRuns = Number.isFinite(maxRunsNum) ? Math.floor(maxRunsNum) : NaN;
  if (!Number.isFinite(maxRuns) || maxRuns <= 0) {
    return { error: 'recurrence requires maxRuns >= 1' };
  }

  if (kind === 'interval') {
    const everyMinutesNum = Number(everyMinutesRaw);
    const everyMinutes = Number.isFinite(everyMinutesNum) ? Math.floor(everyMinutesNum) : NaN;
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      return { error: 'interval recurrence requires everyMinutes >= 1' };
    }
    return { recurrence: { kind: 'interval', maxRuns, everyMinutes } };
  }

  return { recurrence: { kind, maxRuns } };
}

function rejectNonLocal(req: Request, res: Response): boolean {
  if (isLocalRequest(req)) {
    return false;
  }
  res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
  return true;
}

function normalizeTaskCreateItems(body: Record<string, unknown>): { items: Record<string, unknown>[]; error?: string } {
  const itemsRaw = Array.isArray(body.items)
    ? body.items
    : [{
      dueAt: body.dueAt,
      task: body.task,
      tool: body.tool,
      arguments: body.arguments,
      recurrence: body.recurrence ?? body.repeat,
      maxRuns: body.maxRuns,
      everyMinutes: body.everyMinutes
    }];

  const items: Record<string, unknown>[] = [];
  for (const entry of itemsRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { items: [], error: 'items must be objects' };
    }
    const record = entry as Record<string, unknown>;
    const dueAtMs = parseIsoToMs(record.dueAt);
    if (!Number.isFinite(dueAtMs as number)) {
      return { items: [], error: 'dueAt must be ISO8601 datetime' };
    }
    const task = parseString(record.task);
    if (!task) {
      return { items: [], error: 'task must be non-empty string' };
    }
    const recurrenceParsed = parseRecurrenceInput(record.recurrence ?? record.repeat ?? record.cycle, record);
    if (recurrenceParsed.error) {
      return { items: [], error: recurrenceParsed.error };
    }
    const payload: Record<string, unknown> = {
      dueAtMs,
      setBy: 'user',
      task,
      ...(parseString(record.tool) ? { tool: parseString(record.tool) } : {}),
      ...(record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
        ? { arguments: record.arguments as Record<string, unknown> }
        : {}),
      ...(recurrenceParsed.recurrence ? { recurrence: recurrenceParsed.recurrence } : {})
    };
    items.push(payload);
  }
  return { items };
}

function normalizeTaskPatch(body: Record<string, unknown>): { patch: Record<string, unknown>; error?: string } {
  const patchRaw = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
    ? (body.patch as Record<string, unknown>)
    : body;

  const patch: Record<string, unknown> = {};

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'dueAt')) {
    const dueAtMs = parseIsoToMs(patchRaw.dueAt);
    if (!Number.isFinite(dueAtMs as number)) {
      return { patch: {}, error: 'patch.dueAt must be ISO8601 datetime' };
    }
    patch.dueAtMs = dueAtMs;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'task')) {
    const task = parseString(patchRaw.task);
    if (!task) {
      return { patch: {}, error: 'patch.task must be non-empty string' };
    }
    patch.task = task;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'tool')) {
    patch.tool = patchRaw.tool === null ? null : parseString(patchRaw.tool) ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'arguments')) {
    if (patchRaw.arguments === null) {
      patch.arguments = null;
    } else if (patchRaw.arguments && typeof patchRaw.arguments === 'object' && !Array.isArray(patchRaw.arguments)) {
      patch.arguments = patchRaw.arguments;
    } else {
      return { patch: {}, error: 'patch.arguments must be object or null' };
    }
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'notBeforeRequestId')) {
    patch.notBeforeRequestId = patchRaw.notBeforeRequestId === null
      ? null
      : parseString(patchRaw.notBeforeRequestId) ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'recurrence') || Object.prototype.hasOwnProperty.call(patchRaw, 'repeat')) {
    const recurrenceParsed = parseRecurrenceInput(
      patchRaw.recurrence ?? patchRaw.repeat ?? patchRaw.cycle,
      patchRaw
    );
    if (recurrenceParsed.error) {
      return { patch: {}, error: recurrenceParsed.error };
    }
    patch.recurrence = recurrenceParsed.recurrence ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'resetDelivery')) {
    const resetDelivery = parseBoolean(patchRaw.resetDelivery);
    if (resetDelivery === undefined) {
      return { patch: {}, error: 'patch.resetDelivery must be boolean' };
    }
    patch.resetDelivery = resetDelivery;
  }

  return { patch };
}

export function registerClockClientRoutes(app: Application): void {
  const registry = getClockClientRegistry();

  app.post('/daemon/clock-client/register', (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const daemonId = parseString(body.daemonId);
    const callbackUrl = parseString(body.callbackUrl);
    if (!daemonId || !callbackUrl) {
      res.status(400).json({ error: { message: 'daemonId and callbackUrl are required', code: 'bad_request' } });
      return;
    }

    const tmuxSessionId = parseString(body.tmuxSessionId) || parseString(body.sessionId);
    const managedTmuxSession = parseBoolean(body.managedTmuxSession);
    const managedClientProcess = parseBoolean(body.managedClientProcess);
    const managedClientPid = parsePositiveInt(body.managedClientPid);
    const managedClientCommandHint = parseString(body.managedClientCommandHint);
    const rec = registry.register({
      daemonId,
      callbackUrl,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      clientType: parseString(body.clientType),
      tmuxTarget: parseString(body.tmuxTarget),
      ...(managedTmuxSession !== undefined ? { managedTmuxSession } : {}),
      ...(managedClientProcess !== undefined ? { managedClientProcess } : {}),
      ...(managedClientPid ? { managedClientPid } : {}),
      ...(managedClientCommandHint ? { managedClientCommandHint } : {})
    });

    const conversationSessionId = parseString(body.conversationSessionId);
    if (conversationSessionId) {
      registry.bindConversationSession({
        conversationSessionId,
        ...(tmuxSessionId ? { tmuxSessionId } : {}),
        daemonId,
        ...(rec.clientType ? { clientType: rec.clientType } : {})
      });
    }

    res.status(200).json({ ok: true, record: rec });
  });

  app.post('/daemon/clock-client/heartbeat', (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const daemonId = parseString(body.daemonId);
    if (!daemonId) {
      res.status(400).json({ error: { message: 'daemonId is required', code: 'bad_request' } });
      return;
    }
    const ok = registry.heartbeat(daemonId, {
      tmuxSessionId: parseString(body.tmuxSessionId) || parseString(body.sessionId),
      managedTmuxSession: parseBoolean(body.managedTmuxSession),
      managedClientProcess: parseBoolean(body.managedClientProcess),
      managedClientPid: parsePositiveInt(body.managedClientPid),
      managedClientCommandHint: parseString(body.managedClientCommandHint)
    });
    if (!ok) {
      res.status(404).json({ error: { message: 'daemon not found', code: 'not_found' } });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.post('/daemon/clock-client/unregister', (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const daemonId = parseString(body.daemonId);
    if (!daemonId) {
      res.status(400).json({ error: { message: 'daemonId is required', code: 'bad_request' } });
      return;
    }
    const ok = registry.unregister(daemonId);
    res.status(200).json({ ok });
  });

  app.get('/daemon/clock-client/list', (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    res.status(200).json({ ok: true, records: registry.list() });
  });

  app.post('/daemon/clock-client/inject', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const text = parseString(body.text);
    if (!text) {
      res.status(400).json({ error: { message: 'text is required', code: 'bad_request' } });
      return;
    }

    const tmuxSessionId = parseString(body.tmuxSessionId);
    const sessionAlias = parseString(body.sessionId);
    if (!tmuxSessionId && !sessionAlias) {
      res.status(400).json({ error: { message: 'tmuxSessionId is required', code: 'bad_request' } });
      return;
    }

    if (sessionAlias && tmuxSessionId && sessionAlias !== tmuxSessionId) {
      registry.bindConversationSession({
        conversationSessionId: sessionAlias,
        tmuxSessionId,
        clientType: parseString(body.clientType)
      });
    }

    const result = await registry.inject({
      text,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(sessionAlias ? { sessionId: sessionAlias } : {}),
      requestId: parseString(body.requestId),
      source: parseString(body.source)
    });
    if (!result.ok) {
      res.status(503).json({ ok: false, reason: result.reason || 'inject_failed' });
      return;
    }
    res.status(200).json({ ok: true, daemonId: result.daemonId });
  });

  app.get('/daemon/clock/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const clockConfig = await resolveClockConfigSnapshot(undefined);
    if (!clockConfig) {
      res.status(500).json({ ok: false, reason: 'clock_config_unavailable' });
      return;
    }

    const querySessionId = parseString(req.query.sessionId);
    const sessionIds = querySessionId ? [querySessionId] : await listClockSessionIdsSnapshot();

    const sessions = [] as Array<{ sessionId: string; taskCount: number; tasks: unknown[] }>;
    for (const sessionId of sessionIds) {
      const tasks = await listClockTasksSnapshot({ sessionId, config: clockConfig });
      sessions.push({ sessionId, taskCount: tasks.length, tasks });
    }

    res.status(200).json({
      ok: true,
      sessions,
      records: registry.list()
    });
  });

  app.post('/daemon/clock/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sessionId = parseString(body.sessionId);
    if (!sessionId) {
      res.status(400).json({ ok: false, reason: 'sessionId is required' });
      return;
    }
    const normalized = normalizeTaskCreateItems(body);
    if (normalized.error) {
      res.status(400).json({ ok: false, reason: normalized.error });
      return;
    }

    const clockConfig = await resolveClockConfigSnapshot(undefined);
    if (!clockConfig) {
      res.status(500).json({ ok: false, reason: 'clock_config_unavailable' });
      return;
    }

    const scheduled = await scheduleClockTasksSnapshot({
      sessionId,
      items: normalized.items,
      config: clockConfig
    });

    res.status(200).json({ ok: true, sessionId, scheduledCount: scheduled.length, scheduled });
  });

  app.patch('/daemon/clock/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sessionId = parseString(body.sessionId);
    const taskId = parseString(body.taskId);
    if (!sessionId || !taskId) {
      res.status(400).json({ ok: false, reason: 'sessionId and taskId are required' });
      return;
    }

    const normalizedPatch = normalizeTaskPatch(body);
    if (normalizedPatch.error) {
      res.status(400).json({ ok: false, reason: normalizedPatch.error });
      return;
    }

    const clockConfig = await resolveClockConfigSnapshot(undefined);
    if (!clockConfig) {
      res.status(500).json({ ok: false, reason: 'clock_config_unavailable' });
      return;
    }

    const updated = await updateClockTaskSnapshot({
      sessionId,
      taskId,
      patch: normalizedPatch.patch,
      config: clockConfig
    });

    if (!updated) {
      res.status(404).json({ ok: false, reason: 'task_not_found_or_invalid_patch' });
      return;
    }

    res.status(200).json({ ok: true, sessionId, taskId, updated });
  });

  app.delete('/daemon/clock/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sessionId = parseString(body.sessionId);
    if (!sessionId) {
      res.status(400).json({ ok: false, reason: 'sessionId is required' });
      return;
    }

    const clockConfig = await resolveClockConfigSnapshot(undefined);
    if (!clockConfig) {
      res.status(500).json({ ok: false, reason: 'clock_config_unavailable' });
      return;
    }

    const taskId = parseString(body.taskId);
    if (taskId) {
      const removed = await cancelClockTaskSnapshot({ sessionId, taskId, config: clockConfig });
      res.status(200).json({ ok: true, sessionId, taskId, removed });
      return;
    }

    const removedCount = await clearClockTasksSnapshot({ sessionId, config: clockConfig });
    res.status(200).json({ ok: true, sessionId, removedCount });
  });

  app.post('/daemon/clock/cleanup', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const mode = parseString(body.mode) || 'dead_tmux';

    const clockConfig = await resolveClockConfigSnapshot(undefined);
    if (!clockConfig) {
      res.status(500).json({ ok: false, reason: 'clock_config_unavailable' });
      return;
    }

    if (mode === 'unbind') {
      const conversationSessionId = parseString(body.conversationSessionId);
      if (!conversationSessionId) {
        res.status(400).json({ ok: false, reason: 'conversationSessionId is required for mode=unbind' });
        return;
      }
      const unbound = registry.unbindConversationSession(conversationSessionId);
      const clearTasks = parseBoolean(body.clearTasks) === true;
      let cleared = 0;
      if (clearTasks) {
        cleared = await clearClockTasksSnapshot({ sessionId: conversationSessionId, config: clockConfig });
      }
      res.status(200).json({ ok: true, mode, unbound, cleared });
      return;
    }

    const modeSafe = mode.toLowerCase();
    const allowManagedTermination =
      parseBoolean(body.terminateManaged) ?? isClockManagedTerminationEnabled();
    const terminateHandlers = allowManagedTermination
      ? {
          terminateManagedTmuxSession: (tmuxSessionId: string) => killManagedTmuxSession(tmuxSessionId),
          terminateManagedClientProcess: (processInfo: {
            daemonId: string;
            pid: number;
            commandHint?: string;
            clientType?: string;
          }) => terminateManagedClientProcess(processInfo)
        }
      : {};

    const cleanup = modeSafe === 'stale_heartbeat'
      ? registry.cleanupStaleHeartbeats({
        ...terminateHandlers,
        staleAfterMs: Number.isFinite(Number(body.staleAfterMs)) ? Number(body.staleAfterMs) : undefined
      })
      : registry.cleanupDeadTmuxSessions({
        isTmuxSessionAlive,
        ...terminateHandlers
      });
    const cleanupClockSessionIds = Array.from(new Set<string>([
      ...cleanup.removedConversationSessionIds,
      ...cleanup.removedTmuxSessionIds
    ]));

    let clearedTaskSessions = 0;
    for (const cleanupSessionId of cleanupClockSessionIds) {
      await clearClockTasksSnapshot({ sessionId: cleanupSessionId, config: clockConfig });
      clearedTaskSessions += 1;
    }

    res.status(200).json({
      ok: true,
      mode: modeSafe === 'stale_heartbeat' ? 'stale_heartbeat' : 'dead_tmux',
      terminateManaged: allowManagedTermination,
      cleanup,
      clearedTaskSessions
    });
  });
}
