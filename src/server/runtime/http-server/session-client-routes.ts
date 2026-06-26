import type { Application, Request, Response } from 'express';

import { getSessionClientRegistry } from './session-client-registry.js';
import { normalizeWorkdir } from './session-client-registry-utils.js';
import { isLocalRequest, isLoopbackBindHost } from './daemon-admin-routes.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';
import {
  extractApiKeyFromRequest,
  resolveEnvSecretReference
} from './middleware.js';
import {
  parseBoolean,
  parsePositiveInt,
  parseString,
  validateSessionClientCallbackUrl
} from './session-client-route-utils.js';
import { matchesExpectedClientApiKey } from '../../../utils/session-client-token.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';

function logSessionClientRoutesNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length
      ? ` details=${JSON.stringify(details)}`
      : '';
    console.warn(`[session-client-routes] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

export interface SessionClientRouteOptions {
  bindHost?: string;
  expectedApiKey?: string;
}

function rejectUnauthorizedSessionClient(
  req: Request,
  res: Response,
  options: { authRequired: boolean; expectedApiKey: string; configError?: string }
): boolean {
  if (isLocalRequest(req)) {
    return false;
  }
  if (!options.authRequired) {
    res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
    return true;
  }

  if (options.configError) {
    res.status(500).json({ error: { message: options.configError, code: 'config_error' } });
    return true;
  }

  const provided = extractApiKeyFromRequest(req);
  if (provided && matchesExpectedClientApiKey(provided, options.expectedApiKey)) {
    return false;
  }
  res.status(401).json({ error: { message: 'unauthorized', code: 'unauthorized' } });
  return true;
}

export function registerSessionClientRoutes(app: Application, options: SessionClientRouteOptions = {}): void {
  const registry = getSessionClientRegistry();
  const authRequired = typeof options.bindHost === 'string' && options.bindHost.trim()
    ? !isLoopbackBindHost(options.bindHost)
    : false;
  const resolvedApiKey = resolveEnvSecretReference(typeof options.expectedApiKey === 'string' ? options.expectedApiKey : '');
  const sessionClientAuth = {
    authRequired,
    expectedApiKey: resolvedApiKey.ok ? resolvedApiKey.value : '',
    ...(resolvedApiKey.ok ? {} : { configError: `httpserver.apikey env ${resolvedApiKey.missing} is not defined` })
  };

  app.post('/daemon/session-client/register', (req: Request, res: Response) => {
    if (rejectUnauthorizedSessionClient(req, res, sessionClientAuth)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const daemonId = parseString(body.daemonId);
    const callbackUrl = parseString(body.callbackUrl);
    if (!daemonId || !callbackUrl) {
      res.status(400).json({ error: { message: 'daemonId and callbackUrl are required', code: 'bad_request' } });
      return;
    }
    const callbackValidation = validateSessionClientCallbackUrl(callbackUrl);
    if (!callbackValidation.ok) {
      res.status(400).json({
        error: {
          message: callbackValidation.reason,
          code: 'bad_request'
        }
      });
      return;
    }

    const tmuxSessionId = parseString(body.tmuxSessionId) || parseString(body.sessionId);
    const workdir = normalizeWorkdir(parseString(body.workdir) || parseString(body.cwd) || parseString(body.workingDirectory));
    const managedTmuxSession = parseBoolean(body.managedTmuxSession);
    const managedClientProcess = parseBoolean(body.managedClientProcess);
    const managedClientPid = parsePositiveInt(body.managedClientPid);
    const managedClientCommandHint = parseString(body.managedClientCommandHint);
    const conversationSessionId = parseString(body.conversationSessionId);

    const rec = registry.register({
      daemonId,
      callbackUrl: callbackValidation.normalizedUrl,
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

    res.status(200).json({ ok: true, record: rec });
  });

  app.post('/daemon/session-client/heartbeat', (req: Request, res: Response) => {
    if (rejectUnauthorizedSessionClient(req, res, sessionClientAuth)) {
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

  app.post('/daemon/session-client/unregister', (req: Request, res: Response) => {
    if (rejectUnauthorizedSessionClient(req, res, sessionClientAuth)) {
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
    if (rejectUnauthorizedSessionClient(req, res, sessionClientAuth)) {
      return;
    }
    res.status(200).json({ ok: true, records: registry.list() });
  });

  app.post('/daemon/session-client/inject', async (req: Request, res: Response) => {
    if (rejectUnauthorizedSessionClient(req, res, sessionClientAuth)) {
      return;
    }
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const text = parseString(body.text);
    if (!text) {
      res.status(400).json({ error: { message: 'text is required', code: 'bad_request' } });
      return;
    }

    const result = await registry.inject({
      text,
      tmuxSessionId: parseString(body.tmuxSessionId),
      tmuxTarget: parseString(body.tmuxTarget),
      sessionId: parseString(body.sessionId),
      workdir: normalizeWorkdir(parseString(body.workdir) || parseString(body.cwd) || parseString(body.workingDirectory)),
      clientType: parseString(body.clientType),
      tmuxOnly: parseBoolean(body.tmuxOnly),
      requestId: parseString(body.requestId),
      source: parseString(body.source)
    });

    if (result.ok) {
      res.status(200).json(result);
      return;
    }

    const reason = typeof result.reason === 'string' ? result.reason : 'inject_failed';
    if (reason === 'tmux_session_required') {
      res.status(400).json({ error: { message: 'tmuxSessionId is required', code: 'bad_request' } });
      return;
    }
    if (reason === 'no_matching_tmux_session_daemon' || reason === 'workdir_mismatch') {
      res.status(503).json({ error: { message: reason, code: 'service_unavailable' } });
      return;
    }
    res.status(502).json({ error: { message: reason, code: 'bad_gateway' } });
  });

  app.post('/daemon/session/cleanup', async (req: Request, res: Response) => {
    if (rejectUnauthorizedSessionClient(req, res, sessionClientAuth)) {
      return;
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const mode = parseString(body.mode) || 'dead_tmux';


    if (mode === 'unbind') {
      const sessionScope = parseString(body.sessionScope) || parseString(body.conversationSessionId);
      if (!sessionScope) {
        res.status(400).json({ error: { message: 'sessionScope is required for mode=unbind', code: 'bad_request' } });
        return;
      }
      const normalizedSessionScope = sessionScope.startsWith('sessiond.') || sessionScope.startsWith('tmux:')
        ? sessionScope
        : sessionScope;
      const unbound = normalizedSessionScope.startsWith('sessiond.') || normalizedSessionScope.startsWith('tmux:')
        ? registry.unbindSessionScope(normalizedSessionScope)
        : registry.unbindConversationSession(normalizedSessionScope);
      res.status(200).json({ ok: true, mode, sessionScope: normalizedSessionScope, unbound });
      return;
    }

    const modeSafe = mode.toLowerCase();
    const requestedTerminateManaged =
      parseBoolean(body.terminateManaged) ?? false;
    const allowManagedTermination = false;
    const cleanup = modeSafe === 'stale_heartbeat'
      ? registry.cleanupStaleHeartbeats({
        staleAfterMs: Number.isFinite(Number(body.staleAfterMs)) ? Number(body.staleAfterMs) : undefined,
        isTmuxSessionAlive
      })
      : registry.cleanupDeadTmuxSessions({
        isTmuxSessionAlive
      });
    const cleanupSessionIds = Array.from(new Set<string>([
      ...cleanup.removedConversationSessionIds,
      ...cleanup.removedTmuxSessionIds
    ]));

    res.status(200).json({
      ok: true,
      mode: modeSafe === 'stale_heartbeat' ? 'stale_heartbeat' : 'dead_tmux',
      terminateManaged: allowManagedTermination,
      terminateManagedRequested: requestedTerminateManaged,
      cleanup,
      clearedTaskSessions: cleanupSessionIds.length
    });
  });
}
