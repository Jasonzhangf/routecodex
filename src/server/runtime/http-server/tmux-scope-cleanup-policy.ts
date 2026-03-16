export type TmuxScopeLiveness = 'alive' | 'dead' | 'unknown';

export type TmuxScopeCleanupMode =
  | 'stale_record'
  | 'runtime_failure'
  | 'request_guard';

export type TmuxScopeCleanupDecision = {
  tmuxSessionId?: string;
  liveness: TmuxScopeLiveness;
  cleanupTmuxScope: boolean;
  reason: string;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function probeTmuxScopeLiveness(args: {
  tmuxSessionId?: unknown;
  isTmuxSessionAlive?: (tmuxSessionId: string) => boolean;
}): { tmuxSessionId?: string; liveness: TmuxScopeLiveness } {
  const tmuxSessionId = readString(args.tmuxSessionId);
  if (!tmuxSessionId) {
    return { liveness: 'unknown' };
  }
  if (typeof args.isTmuxSessionAlive !== 'function') {
    return { tmuxSessionId, liveness: 'unknown' };
  }
  try {
    return {
      tmuxSessionId,
      liveness: args.isTmuxSessionAlive(tmuxSessionId) ? 'alive' : 'dead',
    };
  } catch {
    return { tmuxSessionId, liveness: 'unknown' };
  }
}

export function evaluateTmuxScopeCleanup(args: {
  mode: TmuxScopeCleanupMode;
  tmuxSessionId?: unknown;
  reason?: unknown;
  isTmuxSessionAlive?: (tmuxSessionId: string) => boolean;
}): TmuxScopeCleanupDecision {
  const tmux = probeTmuxScopeLiveness(args);
  const normalizedReason = readString(args.reason)?.toLowerCase();
  if (!tmux.tmuxSessionId) {
    return {
      liveness: tmux.liveness,
      cleanupTmuxScope: false,
      reason: normalizedReason || 'missing_tmux',
    };
  }

  if (tmux.liveness === 'dead') {
    return {
      tmuxSessionId: tmux.tmuxSessionId,
      liveness: 'dead',
      cleanupTmuxScope: true,
      reason: normalizedReason || 'tmux_dead',
    };
  }

  if (tmux.liveness === 'alive') {
    return {
      tmuxSessionId: tmux.tmuxSessionId,
      liveness: 'alive',
      cleanupTmuxScope: false,
      reason: normalizedReason || `${args.mode}_tmux_alive`,
    };
  }

  return {
    tmuxSessionId: tmux.tmuxSessionId,
    liveness: 'unknown',
    cleanupTmuxScope: false,
    reason: normalizedReason || `${args.mode}_tmux_unknown`,
  };
}
