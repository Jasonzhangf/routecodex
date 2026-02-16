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
import { normalizeWorkdir } from './clock-client-registry-utils.js';
import { isLocalRequest } from './daemon-admin-routes.js';
import { isTmuxSessionAlive, killManagedTmuxSession } from './tmux-session-probe.js';
import { terminateManagedClientProcess } from './managed-process-probe.js';
import {
  isClockManagedTerminationEnabled,
  normalizeTaskCreateItems,
  normalizeTaskPatch,
  parseBoolean,
  parsePositiveInt,
  parseString
} from './clock-client-route-utils.js';

function rejectNonLocal(req: Request, res: Response): boolean {
  if (isLocalRequest(req)) {
    return false;
  }
  res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
  return true;
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
    const workdir = normalizeWorkdir(parseString(body.workdir) || parseString(body.cwd) || parseString(body.workingDirectory));
    const managedTmuxSession = parseBoolean(body.managedTmuxSession);
    const managedClientProcess = parseBoolean(body.managedClientProcess);
    const managedClientPid = parsePositiveInt(body.managedClientPid);
    const managedClientCommandHint = parseString(body.managedClientCommandHint);
    const rec = registry.register({
      daemonId,
      callbackUrl,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(workdir ? { workdir } : {}),
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
        ...(rec.clientType ? { clientType: rec.clientType } : {}),
        ...(rec.workdir ? { workdir: rec.workdir } : {})
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
      workdir: normalizeWorkdir(parseString(body.workdir) || parseString(body.cwd) || parseString(body.workingDirectory)),
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
    const workdir = normalizeWorkdir(parseString(body.workdir) || parseString(body.cwd) || parseString(body.workingDirectory));
    if (!tmuxSessionId && !sessionAlias) {
      res.status(400).json({ error: { message: 'tmuxSessionId is required', code: 'bad_request' } });
      return;
    }

    if (sessionAlias && tmuxSessionId && sessionAlias !== tmuxSessionId) {
      registry.bindConversationSession({
        conversationSessionId: sessionAlias,
        tmuxSessionId,
        clientType: parseString(body.clientType),
        ...(workdir ? { workdir } : {})
      });
    }

    const result = await registry.inject({
      text,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(sessionAlias ? { sessionId: sessionAlias } : {}),
      ...(workdir ? { workdir } : {}),
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
