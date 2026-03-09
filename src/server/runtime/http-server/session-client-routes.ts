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
import { getSessionClientRegistry } from './session-client-registry.js';
import { normalizeWorkdir } from './session-client-registry-utils.js';
import { isLocalRequest } from './daemon-admin-routes.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';
import {
  isSessionManagedTerminationEnabled,
  normalizeClockSessionIdInput,
  normalizeTaskCreateItems,
  normalizeTaskPatch,
  parseBoolean,
  parsePositiveInt,
  parseString
} from './session-client-route-utils.js';
import { clearStopMessageTmuxScope, migrateStopMessageTmuxScope } from './stopmessage-scope-rebind.js';

function rejectNonLocal(req: Request, res: Response): boolean {
  if (isLocalRequest(req)) {
    return false;
  }
  res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
  return true;
}

export function registerSessionClientRoutes(app: Application): void {
  const registry = getSessionClientRegistry();

  app.post('/daemon/session-client/register', (req: Request, res: Response) => {
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
    const previousRecord = registry.findByDaemonId(daemonId);
    const previousDaemonTmuxSessionId =
      parseString((previousRecord as Record<string, unknown> | undefined)?.tmuxSessionId) ||
      parseString((previousRecord as Record<string, unknown> | undefined)?.sessionId);
    const conversationSessionId = parseString(body.conversationSessionId);
    const previousConversationTmuxSessionId = conversationSessionId
      ? registry.resolveBoundTmuxSession(conversationSessionId)
      : undefined;

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

    if (conversationSessionId) {
      registry.bindConversationSession({
        conversationSessionId,
        ...(tmuxSessionId ? { tmuxSessionId } : {}),
        daemonId,
        ...(rec.clientType ? { clientType: rec.clientType } : {}),
        ...(rec.workdir ? { workdir: rec.workdir } : {})
      });
    }

    const effectiveTmuxSessionId = parseString(rec.tmuxSessionId) || parseString(rec.sessionId);
    const rebindOldTmuxCandidates = Array.from(
      new Set(
        [previousDaemonTmuxSessionId, previousConversationTmuxSessionId]
          .map((entry) => parseString(entry))
          .filter((entry): entry is string => Boolean(entry))
      )
    );
    for (const oldTmuxSessionId of rebindOldTmuxCandidates) {
      const rebindResult = migrateStopMessageTmuxScope({
        oldTmuxSessionId,
        newTmuxSessionId: effectiveTmuxSessionId,
        reason: 'session_client_register'
      });
      if (rebindResult.migrated) {
        console.log(
          `[stop_scope][rebind] stage=register daemon=${daemonId} old=${rebindResult.oldScope || 'n/a'} new=${rebindResult.newScope || 'n/a'} result=migrated`
        );
      }
    }

    res.status(200).json({ ok: true, record: rec });
  });

  app.post('/daemon/session-client/heartbeat', (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const daemonId = parseString(body.daemonId);
    if (!daemonId) {
      res.status(400).json({ error: { message: 'daemonId is required', code: 'bad_request' } });
      return;
    }
    const previousRecord = registry.findByDaemonId(daemonId);
    const previousTmuxSessionId =
      parseString((previousRecord as Record<string, unknown> | undefined)?.tmuxSessionId) ||
      parseString((previousRecord as Record<string, unknown> | undefined)?.sessionId);
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
    const updatedRecord = registry.findByDaemonId(daemonId);
    const updatedTmuxSessionId =
      parseString((updatedRecord as Record<string, unknown> | undefined)?.tmuxSessionId) ||
      parseString((updatedRecord as Record<string, unknown> | undefined)?.sessionId);
    const rebindResult = migrateStopMessageTmuxScope({
      oldTmuxSessionId: previousTmuxSessionId,
      newTmuxSessionId: updatedTmuxSessionId,
      reason: 'session_client_heartbeat'
    });
    if (rebindResult.migrated) {
      console.log(
        `[stop_scope][rebind] stage=heartbeat daemon=${daemonId} old=${rebindResult.oldScope || 'n/a'} new=${rebindResult.newScope || 'n/a'} result=migrated`
      );
    }
    res.status(200).json({ ok: true });
  });

  app.post('/daemon/session-client/unregister', (req: Request, res: Response) => {
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

  app.get('/daemon/session-client/list', (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    res.status(200).json({ ok: true, records: registry.list() });
  });

  app.post('/daemon/session-client/inject', async (req: Request, res: Response) => {
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

  app.get('/daemon/session/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const sessionConfig = await resolveClockConfigSnapshot(undefined);
    if (!sessionConfig) {
      res.status(500).json({ ok: false, reason: 'session_config_unavailable' });
      return;
    }

    const querySessionId = normalizeClockSessionIdInput(req.query.sessionId);
    const sessionIds = querySessionId ? [querySessionId] : await listClockSessionIdsSnapshot();

    const sessions = [] as Array<{ sessionId: string; taskCount: number; tasks: unknown[] }>;
    for (const sessionId of sessionIds) {
      const tasks = await listClockTasksSnapshot({ sessionId, config: sessionConfig });
      sessions.push({ sessionId, taskCount: tasks.length, tasks });
    }

    res.status(200).json({
      ok: true,
      sessions,
      records: registry.list()
    });
  });

  app.post('/daemon/session/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sessionId = normalizeClockSessionIdInput(body.sessionId);
    if (!sessionId) {
      res.status(400).json({ ok: false, reason: 'sessionId is required and must resolve to tmux scope' });
      return;
    }
    const normalized = normalizeTaskCreateItems(body);
    if (normalized.error) {
      res.status(400).json({ ok: false, reason: normalized.error });
      return;
    }

    const sessionConfig = await resolveClockConfigSnapshot(undefined);
    if (!sessionConfig) {
      res.status(500).json({ ok: false, reason: 'session_config_unavailable' });
      return;
    }

    const scheduled = await scheduleClockTasksSnapshot({
      sessionId,
      items: normalized.items,
      config: sessionConfig
    });

    res.status(200).json({ ok: true, sessionId, scheduledCount: scheduled.length, scheduled });
  });

  app.patch('/daemon/session/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sessionId = normalizeClockSessionIdInput(body.sessionId);
    const taskId = parseString(body.taskId);
    if (!sessionId || !taskId) {
      res.status(400).json({ ok: false, reason: 'sessionId and taskId are required; sessionId must resolve to tmux scope' });
      return;
    }

    const normalizedPatch = normalizeTaskPatch(body);
    if (normalizedPatch.error) {
      res.status(400).json({ ok: false, reason: normalizedPatch.error });
      return;
    }

    const sessionConfig = await resolveClockConfigSnapshot(undefined);
    if (!sessionConfig) {
      res.status(500).json({ ok: false, reason: 'session_config_unavailable' });
      return;
    }

    const updated = await updateClockTaskSnapshot({
      sessionId,
      taskId,
      patch: normalizedPatch.patch,
      config: sessionConfig
    });

    if (!updated) {
      res.status(404).json({ ok: false, reason: 'task_not_found_or_invalid_patch' });
      return;
    }

    res.status(200).json({ ok: true, sessionId, taskId, updated });
  });

  app.delete('/daemon/session/tasks', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const sessionId = normalizeClockSessionIdInput(body.sessionId);
    if (!sessionId) {
      res.status(400).json({ ok: false, reason: 'sessionId is required and must resolve to tmux scope' });
      return;
    }

    const sessionConfig = await resolveClockConfigSnapshot(undefined);
    if (!sessionConfig) {
      res.status(500).json({ ok: false, reason: 'session_config_unavailable' });
      return;
    }

    const taskId = parseString(body.taskId);
    if (taskId) {
      const removed = await cancelClockTaskSnapshot({ sessionId, taskId, config: sessionConfig });
      res.status(200).json({ ok: true, sessionId, taskId, removed });
      return;
    }

    const removedCount = await clearClockTasksSnapshot({ sessionId, config: sessionConfig });
    res.status(200).json({ ok: true, sessionId, removedCount });
  });

  app.post('/daemon/session/cleanup', async (req: Request, res: Response) => {
    if (rejectNonLocal(req, res)) {
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const mode = parseString(body.mode) || 'dead_tmux';

    const sessionConfig = await resolveClockConfigSnapshot(undefined);
    if (!sessionConfig) {
      res.status(500).json({ ok: false, reason: 'session_config_unavailable' });
      return;
    }

    if (mode === 'unbind') {
      const sessionScope = parseString(body.sessionScope) || parseString(body.conversationSessionId);
      if (!sessionScope) {
        res.status(400).json({ ok: false, reason: 'sessionScope is required for mode=unbind' });
        return;
      }
      const normalizedSessionScope = sessionScope.startsWith('sessiond.') || sessionScope.startsWith('tmux:')
        ? sessionScope
        : normalizeClockSessionIdInput(sessionScope) ?? sessionScope;
      const unbound = normalizedSessionScope.startsWith('sessiond.') || normalizedSessionScope.startsWith('tmux:')
        ? registry.unbindSessionScope(normalizedSessionScope)
        : registry.unbindConversationSession(normalizedSessionScope);
      const clearTasks = parseBoolean(body.clearTasks) === true;
      let cleared = 0;
      if (clearTasks) {
        cleared = await clearClockTasksSnapshot({
          sessionId: normalizeClockSessionIdInput(normalizedSessionScope) ?? normalizedSessionScope,
          config: sessionConfig
        });
      }
      const clearedStopMessage = normalizedSessionScope.startsWith('tmux:')
        ? clearStopMessageTmuxScope({
          tmuxSessionId: normalizedSessionScope.slice('tmux:'.length),
          reason: 'session_unbind'
        })
        : undefined;
      res.status(200).json({ ok: true, mode, sessionScope: normalizedSessionScope, unbound, cleared, clearedStopMessage });
      return;
    }

    const modeSafe = mode.toLowerCase();
    const requestedTerminateManaged =
      parseBoolean(body.terminateManaged) ?? isSessionManagedTerminationEnabled();
    const allowManagedTermination = false;
    const cleanup = modeSafe === 'stale_heartbeat'
      ? registry.cleanupStaleHeartbeats({
        staleAfterMs: Number.isFinite(Number(body.staleAfterMs)) ? Number(body.staleAfterMs) : undefined
      })
      : registry.cleanupDeadTmuxSessions({
        isTmuxSessionAlive
      });
    const cleanupSessionIds = Array.from(new Set<string>([
      ...cleanup.removedConversationSessionIds,
      ...cleanup.removedTmuxSessionIds
    ]));

    let clearedTaskSessions = 0;
    for (const cleanupSessionId of cleanupSessionIds) {
      const normalizedCleanupSessionId = normalizeClockSessionIdInput(cleanupSessionId) ?? cleanupSessionId;
      await clearClockTasksSnapshot({ sessionId: normalizedCleanupSessionId, config: sessionConfig });
      clearedTaskSessions += 1;
    }
    let clearedStopMessageScopes = 0;
    const removedTmuxIds = Array.from(new Set(cleanup.removedTmuxSessionIds));
    for (const tmuxSessionId of removedTmuxIds) {
      const cleared = clearStopMessageTmuxScope({
        tmuxSessionId,
        reason: modeSafe === 'stale_heartbeat' ? 'session_cleanup_stale' : 'session_cleanup_dead_tmux'
      });
      if (cleared.cleared) {
        clearedStopMessageScopes += 1;
      }
    }

    res.status(200).json({
      ok: true,
      mode: modeSafe === 'stale_heartbeat' ? 'stale_heartbeat' : 'dead_tmux',
      terminateManaged: allowManagedTermination,
      terminateManagedRequested: requestedTerminateManaged,
      cleanup,
      clearedTaskSessions,
      clearedStopMessageScopes
    });
  });
}
