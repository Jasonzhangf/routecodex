import { spawnSync } from 'node:child_process';
import { logProcessLifecycle } from '../../../utils/process-lifecycle-logger.js';

let tmuxAvailableCache: boolean | null = null;
const MANAGED_TMUX_SESSION_PREFIX = 'rcc_';

function normalizeTmuxSessionTarget(tmuxSessionId: string): string {
  const target = String(tmuxSessionId || '').trim();
  if (!target) {
    return '';
  }
  const separatorIndex = target.indexOf(':');
  if (separatorIndex < 0) {
    return target;
  }
  return target.slice(0, separatorIndex).trim();
}

function logTmuxKillEvent(input: {
  tmuxSessionId: string;
  result: 'attempt' | 'success' | 'failed' | 'skipped';
  reason: string;
}): void {
  const sessionName = normalizeTmuxSessionTarget(input.tmuxSessionId);
  logProcessLifecycle({
    event: 'kill_attempt',
    source: 'http.clock-managed-tmux-reaper',
    details: {
      tmuxSessionId: sessionName || null,
      signal: 'TMUX_KILL_SESSION',
      result: input.result,
      reason: input.reason
    }
  });
}

function isTmuxAvailable(): boolean {
  if (tmuxAvailableCache !== null) {
    return tmuxAvailableCache;
  }
  try {
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
    tmuxAvailableCache = result.status === 0;
  } catch {
    tmuxAvailableCache = false;
  }
  return tmuxAvailableCache;
}

export function isManagedClockTmuxSession(tmuxSessionId: string): boolean {
  const sessionName = normalizeTmuxSessionTarget(tmuxSessionId);
  return sessionName.startsWith(MANAGED_TMUX_SESSION_PREFIX);
}

export function isTmuxSessionAlive(tmuxSessionId: string): boolean {
  const target = normalizeTmuxSessionTarget(tmuxSessionId);
  if (!target) {
    return false;
  }
  if (!isTmuxAvailable()) {
    return true;
  }
  try {
    const result = spawnSync('tmux', ['has-session', '-t', target], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return true;
  }
}

export function killManagedTmuxSession(tmuxSessionId: string): boolean {
  const target = normalizeTmuxSessionTarget(tmuxSessionId);
  if (!target) {
    logTmuxKillEvent({ tmuxSessionId, result: 'skipped', reason: 'invalid_target' });
    return false;
  }
  if (!isManagedClockTmuxSession(target)) {
    logTmuxKillEvent({ tmuxSessionId: target, result: 'skipped', reason: 'unmanaged_session' });
    return false;
  }
  if (!isTmuxAvailable()) {
    logTmuxKillEvent({ tmuxSessionId: target, result: 'skipped', reason: 'tmux_unavailable' });
    return false;
  }

  try {
    const hasSession = spawnSync('tmux', ['has-session', '-t', target], { encoding: 'utf8' });
    if (hasSession.status !== 0) {
      logTmuxKillEvent({ tmuxSessionId: target, result: 'success', reason: 'session_not_found' });
      return true;
    }

    logTmuxKillEvent({ tmuxSessionId: target, result: 'attempt', reason: 'kill_session' });
    const result = spawnSync('tmux', ['kill-session', '-t', target], { encoding: 'utf8' });
    if (result.status === 0) {
      logTmuxKillEvent({ tmuxSessionId: target, result: 'success', reason: 'session_killed' });
      return true;
    }

    const errorText = String(result.stderr || result.stdout || '').trim();
    logTmuxKillEvent({
      tmuxSessionId: target,
      result: 'failed',
      reason: errorText ? `kill_failed:${errorText.slice(0, 120)}` : 'kill_failed'
    });
    return false;
  } catch {
    logTmuxKillEvent({ tmuxSessionId: target, result: 'failed', reason: 'kill_exception' });
    return false;
  }
}
