import {
  saveRoutingInstructionStateSync,
  setClockRuntimeHooksSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { getSessionClientRegistry, injectSessionClientPromptWithResult } from './session-client-registry.js';
import { clearStopMessageTmuxScope } from './stopmessage-scope-rebind.js';
import { evaluateTmuxScopeCleanup } from './tmux-scope-cleanup-policy.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clearClockRuntimeScopeArtifacts(tmuxSessionId: string): void {
  const registry = getSessionClientRegistry();
  const unbound = registry.unbindSessionScope(`tmux:${tmuxSessionId}`);
  for (const daemonId of unbound.daemonIds) {
    try {
      saveRoutingInstructionStateSync(`sessiond.${daemonId}`, null);
    } catch {
      // best-effort only
    }
  }
  for (const removedTmuxSessionId of unbound.tmuxSessionIds) {
    try {
      saveRoutingInstructionStateSync(`tmux:${removedTmuxSessionId}`, null);
    } catch {
      // best-effort only
    }
    try {
      clearStopMessageTmuxScope({
        tmuxSessionId: removedTmuxSessionId,
        reason: 'clock_runtime_cleanup'
      });
    } catch {
      // best-effort only
    }
  }
}

function shouldCleanupClockSession(reasonRaw: unknown, tmuxSessionId: string): boolean {
  return evaluateTmuxScopeCleanup({
    mode: 'runtime_failure',
    tmuxSessionId,
    reason: reasonRaw,
    isTmuxSessionAlive
  }).cleanupTmuxScope;
}

export async function registerClockRuntimeHooks(): Promise<void> {
  await setClockRuntimeHooksSnapshot({
    isTmuxSessionAlive: (tmuxSessionId: string) => {
      const normalized = readString(tmuxSessionId);
      return normalized ? isTmuxSessionAlive(normalized) : false;
    },
    dispatchDueTask: async (request) => {
      const tmuxSessionId = readString(request?.tmuxSessionId);
      if (!tmuxSessionId) {
        return { ok: false, cleanupSession: true, reason: 'tmux_session_required' };
      }

      const injectText = readString(request?.injectText);
      if (!injectText) {
        return { ok: false, reason: 'empty_text' };
      }

      const injectResult = await injectSessionClientPromptWithResult({
        tmuxSessionId,
        sessionId: tmuxSessionId,
        tmuxOnly: true,
        text: injectText,
        requestId: `clock:${readString((request?.task as Record<string, unknown> | undefined)?.taskId) || 'task'}`,
        source: 'clock_daemon'
      });

      if (injectResult.ok) {
        return { ok: true };
      }

      const reason = readString(injectResult.reason) || 'inject_failed';
      if (shouldCleanupClockSession(reason, tmuxSessionId)) {
        clearClockRuntimeScopeArtifacts(tmuxSessionId);
        return { ok: false, cleanupSession: true, reason };
      }
      return { ok: false, reason };
    }
  });
}

export async function clearClockRuntimeHooks(): Promise<void> {
  await setClockRuntimeHooksSnapshot(undefined);
}
