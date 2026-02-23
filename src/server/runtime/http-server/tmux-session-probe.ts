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

function resolveTmuxInjectionTarget(targetRaw: string): { sessionName: string; target: string } {
  const target = String(targetRaw || '').trim();
  if (!target) {
    return { sessionName: '', target: '' };
  }
  const separatorIndex = target.indexOf(':');
  if (separatorIndex < 0) {
    return { sessionName: target, target };
  }
  const sessionName = target.slice(0, separatorIndex).trim();
  return {
    sessionName,
    target
  };
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

function normalizeTmuxInjectedText(raw: string): string {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
}

function sendTmuxSubmitKey(
  target: string,
  clientType?: string
): { ok: true } | { ok: false; reason: string } {
  const normalizedClientType = String(clientType || '').trim().toLowerCase();
  const submitKeys =
    normalizedClientType === 'codex' || normalizedClientType === 'claude'
      ? ['C-m', 'Enter', 'KPEnter']
      : ['C-m', 'Enter', 'KPEnter'];
  let lastReason = 'tmux_submit_failed';
  for (const submitKey of submitKeys) {
    try {
      const result = spawnSync('tmux', ['send-keys', '-t', target, submitKey], { encoding: 'utf8' });
      if (result.status === 0) {
        return { ok: true };
      }
      const detail = String(result.stderr || result.stdout || '').trim();
      lastReason = detail ? `tmux_submit_failed:${detail.slice(0, 120)}` : 'tmux_submit_failed';
    } catch (error) {
      lastReason = error instanceof Error ? `tmux_submit_failed:${error.message}` : 'tmux_submit_failed';
    }
  }
  for (const fallback of ['\r', '\n']) {
    try {
      const literal = spawnSync('tmux', ['send-keys', '-t', target, '-l', '--', fallback], { encoding: 'utf8' });
      if (literal.status === 0) {
        return { ok: true };
      }
      const detail = String(literal.stderr || literal.stdout || '').trim();
      lastReason = detail ? `tmux_submit_failed:${detail.slice(0, 120)}` : 'tmux_submit_failed';
    } catch (error) {
      lastReason = error instanceof Error ? `tmux_submit_failed:${error.message}` : 'tmux_submit_failed';
    }
  }
  return { ok: false, reason: lastReason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function injectTmuxSessionText(input: {
  tmuxSessionId: string;
  clientType?: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const resolvedTarget = resolveTmuxInjectionTarget(input.tmuxSessionId);
  if (!resolvedTarget.sessionName || !resolvedTarget.target) {
    return { ok: false, reason: 'tmux_session_required' };
  }
  const text = normalizeTmuxInjectedText(input.text);
  if (!text) {
    return { ok: false, reason: 'empty_text' };
  }
  if (!isTmuxAvailable()) {
    return { ok: false, reason: 'tmux_unavailable' };
  }
  if (!isTmuxSessionAlive(resolvedTarget.sessionName)) {
    return { ok: false, reason: 'tmux_session_not_found' };
  }
  try {
    // Ensure target pane is in normal mode so Enter can be delivered reliably.
    spawnSync('tmux', ['send-keys', '-t', resolvedTarget.target, '-X', 'cancel'], { encoding: 'utf8' });
    const literal = spawnSync('tmux', ['send-keys', '-t', resolvedTarget.target, '-l', '--', text], { encoding: 'utf8' });
    if (literal.status !== 0) {
      const detail = String(literal.stderr || literal.stdout || '').trim();
      return { ok: false, reason: detail ? `tmux_send_failed:${detail.slice(0, 120)}` : 'tmux_send_failed' };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? `tmux_send_failed:${error.message}` : 'tmux_send_failed' };
  }
  await sleep(80);
  const submit = sendTmuxSubmitKey(resolvedTarget.target, input.clientType);
  if (!submit.ok) {
    return submit;
  }
  return { ok: true };
}
