import { spawnSync } from 'node:child_process';
import { logProcessLifecycle } from '../../../utils/process-lifecycle-logger.js';

let tmuxAvailableCache: boolean | null = null;
const DEFAULT_TMUX_PROBE_CACHE_TTL_MS = 1200;
const DEFAULT_TMUX_PROBE_CACHE_MAX_ENTRIES = 256;
const TMUX_PROBE_ERROR_LOG_THROTTLE_MS = 10_000;
const MANAGED_TMUX_SESSION_PREFIXES = ['rcc-', 'rcc_'] as const;
type TmuxAliveCacheEntry = { alive: boolean; expiresAt: number };
type TmuxWorkdirCacheEntry = { workdir?: string; expiresAt: number };
type TmuxIdleCacheEntry = { idle: boolean; expiresAt: number };
const tmuxAliveCache = new Map<string, TmuxAliveCacheEntry>();
const tmuxWorkdirCache = new Map<string, TmuxWorkdirCacheEntry>();
const tmuxIdleCache = new Map<string, TmuxIdleCacheEntry>();
const tmuxProbeErrorLogAt = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown');
}

function logTmuxProbeNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const key = `${stage}:${typeof details?.target === 'string' ? details.target : ''}`;
    const now = Date.now();
    const lastAt = tmuxProbeErrorLogAt.get(key) ?? 0;
    if (now - lastAt < TMUX_PROBE_ERROR_LOG_THROTTLE_MS) {
      return;
    }
    tmuxProbeErrorLogAt.set(key, now);
    const detailSuffix = details && Object.keys(details).length
      ? ` details=${JSON.stringify(details)}`
      : '';
    console.warn(`[tmux-session-probe] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking warnings.
  }
}

function resolveTmuxProbeCacheMaxEntries(): number {
  const raw = String(
    process.env.ROUTECODEX_TMUX_PROBE_CACHE_MAX_ENTRIES
      ?? process.env.RCC_TMUX_PROBE_CACHE_MAX_ENTRIES
      ?? ''
  ).trim();
  if (!raw) {
    return DEFAULT_TMUX_PROBE_CACHE_MAX_ENTRIES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_TMUX_PROBE_CACHE_MAX_ENTRIES;
  }
  return Math.floor(parsed);
}

function enforceCacheBudget<T>(map: Map<string, T>): void {
  const maxEntries = resolveTmuxProbeCacheMaxEntries();
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

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
    source: 'http.session-managed-tmux-reaper',
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
  } catch (error) {
    logTmuxProbeNonBlockingError('tmux_available_check', error);
    tmuxAvailableCache = false;
  }
  return tmuxAvailableCache;
}

function resolveTmuxProbeCacheTtlMs(): number {
  const raw = String(
    process.env.ROUTECODEX_TMUX_PROBE_CACHE_TTL_MS
      ?? process.env.RCC_TMUX_PROBE_CACHE_TTL_MS
      ?? ''
  ).trim();
  if (!raw) {
    return DEFAULT_TMUX_PROBE_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TMUX_PROBE_CACHE_TTL_MS;
  }
  return Math.floor(parsed);
}

function readAliveCache(target: string, at: number): boolean | undefined {
  const cached = tmuxAliveCache.get(target);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= at) {
    tmuxAliveCache.delete(target);
    return undefined;
  }
  return cached.alive;
}

function writeAliveCache(target: string, alive: boolean, at: number): void {
  const ttlMs = resolveTmuxProbeCacheTtlMs();
  if (ttlMs <= 0) {
    tmuxAliveCache.delete(target);
    return;
  }
  tmuxAliveCache.set(target, {
    alive,
    expiresAt: at + ttlMs
  });
  enforceCacheBudget(tmuxAliveCache);
  if (!alive) {
    tmuxWorkdirCache.delete(target);
    tmuxIdleCache.delete(target);
  }
}

function readWorkdirCache(target: string, at: number): string | undefined | null {
  const cached = tmuxWorkdirCache.get(target);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= at) {
    tmuxWorkdirCache.delete(target);
    return null;
  }
  return cached.workdir;
}

function writeWorkdirCache(target: string, workdir: string | undefined, at: number): void {
  const ttlMs = resolveTmuxProbeCacheTtlMs();
  if (ttlMs <= 0) {
    tmuxWorkdirCache.delete(target);
    return;
  }
  tmuxWorkdirCache.set(target, {
    workdir,
    expiresAt: at + ttlMs
  });
  enforceCacheBudget(tmuxWorkdirCache);
}

function readIdleCache(target: string, at: number): boolean | undefined {
  const cached = tmuxIdleCache.get(target);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= at) {
    tmuxIdleCache.delete(target);
    return undefined;
  }
  return cached.idle;
}

function writeIdleCache(target: string, idle: boolean, at: number): void {
  const ttlMs = resolveTmuxProbeCacheTtlMs();
  if (ttlMs <= 0) {
    tmuxIdleCache.delete(target);
    return;
  }
  tmuxIdleCache.set(target, {
    idle,
    expiresAt: at + ttlMs
  });
  enforceCacheBudget(tmuxIdleCache);
}

function clearSessionProbeCache(target: string): void {
  if (!target) {
    return;
  }
  tmuxAliveCache.delete(target);
  tmuxWorkdirCache.delete(target);
  tmuxIdleCache.delete(target);
}

export function isManagedClockTmuxSession(tmuxSessionId: string): boolean {
  const sessionName = normalizeTmuxSessionTarget(tmuxSessionId);
  return MANAGED_TMUX_SESSION_PREFIXES.some((prefix) => sessionName.startsWith(prefix));
}

export function isTmuxSessionAlive(
  tmuxSessionId: string,
  options?: { forceRefresh?: boolean }
): boolean {
  const target = normalizeTmuxSessionTarget(tmuxSessionId);
  if (!target) {
    return false;
  }
  if (!isTmuxAvailable()) {
    return true;
  }
  const now = Date.now();
  if (!options?.forceRefresh) {
    const cached = readAliveCache(target, now);
    if (typeof cached === 'boolean') {
      return cached;
    }
  }
  try {
    const result = spawnSync('tmux', ['has-session', '-t', target], { encoding: 'utf8' });
    const alive = result.status === 0;
    writeAliveCache(target, alive, now);
    if (!alive) {
      writeWorkdirCache(target, undefined, now);
    }
    return alive;
  } catch (error) {
    logTmuxProbeNonBlockingError('has_session', error, { target });
    return true;
  }
}

export function resolveTmuxSessionWorkingDirectory(tmuxSessionId: string): string | undefined {
  const target = normalizeTmuxSessionTarget(tmuxSessionId);
  if (!target) {
    return undefined;
  }
  if (!isTmuxAvailable()) {
    return undefined;
  }
  const now = Date.now();
  const cached = readWorkdirCache(target, now);
  if (cached !== null) {
    return cached;
  }
  try {
    const result = spawnSync('tmux', ['display-message', '-p', '-t', target, '#{pane_current_path}'], { encoding: 'utf8' });
    if (result.status !== 0) {
      writeWorkdirCache(target, undefined, now);
      return undefined;
    }
    const candidate = String(result.stdout || '').trim();
    if (!candidate || !candidate.startsWith('/')) {
      writeWorkdirCache(target, undefined, now);
      return undefined;
    }
    writeWorkdirCache(target, candidate, now);
    return candidate;
  } catch (error) {
    logTmuxProbeNonBlockingError('resolve_workdir', error, { target });
    return undefined;
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
      writeAliveCache(target, false, Date.now());
      logTmuxKillEvent({ tmuxSessionId: target, result: 'success', reason: 'session_not_found' });
      return true;
    }

    logTmuxKillEvent({ tmuxSessionId: target, result: 'attempt', reason: 'kill_session' });
    const result = spawnSync('tmux', ['kill-session', '-t', target], { encoding: 'utf8' });
    if (result.status === 0) {
      writeAliveCache(target, false, Date.now());
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
  } catch (error) {
    logTmuxProbeNonBlockingError('kill_managed_session', error, { target });
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

function stripAnsi(raw: string): string {
  return String(raw || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function isReusableIdlePaneCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized === 'zsh'
    || normalized === 'bash'
    || normalized === 'sh'
    || normalized === 'fish'
    || normalized === 'nu';
}

function isAgentPaneCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'codex'
    || normalized === 'claude'
    || normalized === 'routecodex'
    || normalized === 'node';
}

function captureLooksIdleForAgent(command: string, capturedTail: string): boolean {
  const normalizedCommand = String(command || '').trim().toLowerCase();
  const lines = String(capturedTail || '')
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-12);
  if (lines.length < 1) {
    return false;
  }
  if (lines.some((line) => /^[\s]*[›❯]\s+\S/.test(line))) {
    return true;
  }
  if ((normalizedCommand === 'claude' || normalizedCommand === 'node') && lines.some((line) => /^[\s]*>\s+\S/.test(line))) {
    return true;
  }
  return false;
}

export function isTmuxSessionIdleForInject(tmuxSessionId: string): boolean | undefined {
  const resolvedTarget = resolveTmuxInjectionTarget(tmuxSessionId);
  if (!resolvedTarget.sessionName || !resolvedTarget.target) {
    return undefined;
  }
  if (!isTmuxAvailable()) {
    return undefined;
  }
  const now = Date.now();
  const cachedIdle = readIdleCache(resolvedTarget.sessionName, now);
  if (typeof cachedIdle === 'boolean') {
    return cachedIdle;
  }
  if (!isTmuxSessionAlive(resolvedTarget.sessionName)) {
    return undefined;
  }
  try {
    const paneResult = spawnSync(
      'tmux',
      ['list-panes', '-t', resolvedTarget.target, '-F', '#{pane_current_command}\t#{pane_in_mode}'],
      { encoding: 'utf8' }
    );
    if (paneResult.status !== 0) {
      return undefined;
    }
    const firstLine = String(paneResult.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) {
      return undefined;
    }
    const [paneCommandRaw, paneInModeRaw] = firstLine.split('\t');
    const paneCommand = String(paneCommandRaw || '').trim();
    const paneInMode = String(paneInModeRaw || '').trim() === '1';
    if (paneInMode) {
      writeIdleCache(resolvedTarget.sessionName, false, now);
      return false;
    }
    if (isReusableIdlePaneCommand(paneCommand)) {
      writeIdleCache(resolvedTarget.sessionName, true, now);
      return true;
    }
    if (!isAgentPaneCommand(paneCommand)) {
      writeIdleCache(resolvedTarget.sessionName, false, now);
      return false;
    }
    const capture = spawnSync('tmux', ['capture-pane', '-p', '-t', resolvedTarget.target, '-S', '-80'], { encoding: 'utf8' });
    if (capture.status !== 0) {
      return undefined;
    }
    const idle = captureLooksIdleForAgent(paneCommand, String(capture.stdout || ''));
    writeIdleCache(resolvedTarget.sessionName, idle, now);
    return idle;
  } catch (error) {
    logTmuxProbeNonBlockingError('probe_idle', error, { target: resolvedTarget.target });
    return undefined;
  }
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
  if (!isTmuxSessionAlive(resolvedTarget.sessionName, { forceRefresh: true })) {
    writeAliveCache(resolvedTarget.sessionName, false, Date.now());
    return { ok: false, reason: 'tmux_session_not_found' };
  }
  clearSessionProbeCache(resolvedTarget.sessionName);
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
  writeAliveCache(resolvedTarget.sessionName, true, Date.now());
  tmuxIdleCache.delete(resolvedTarget.sessionName);
  return { ok: true };
}
