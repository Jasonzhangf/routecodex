import { spawnSync } from 'node:child_process';
import { logProcessLifecycle } from '../../../utils/process-lifecycle-logger.js';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePid(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 1) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function readProcessCommand(pid: number): string {
  if (process.platform === 'win32') {
    return '';
  }
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (out.error || Number(out.status ?? 0) !== 0) {
      return '';
    }
    return normalizeString(out.stdout);
  } catch {
    return '';
  }
}

function isForbiddenCommand(command: string): boolean {
  const normalized = normalizeString(command).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('routecodex/dist/index.js')) {
    return true;
  }
  if (normalized.includes('@jsonstudio/rcc') && normalized.includes('/dist/index.js')) {
    return true;
  }
  return false;
}

function matchesCommandHint(command: string, commandHint?: string, clientType?: string): boolean {
  const normalizedCommand = normalizeString(command).toLowerCase();
  const normalizedHint = normalizeString(commandHint).toLowerCase();
  if (normalizedHint) {
    const hintTokens = normalizedHint
      .split(/[\\/\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (hintTokens.some((token) => token.length >= 3 && normalizedCommand.includes(token))) {
      return true;
    }
  }

  const normalizedClientType = normalizeString(clientType).toLowerCase();
  if (normalizedClientType && normalizedCommand.includes(normalizedClientType)) {
    return true;
  }

  return false;
}

function logManagedClientKillEvent(input: {
  daemonId: string;
  pid: number | null;
  signal: string;
  result: 'attempt' | 'success' | 'failed' | 'skipped';
  reason: string;
  clientType?: string;
  commandHint?: string;
  command?: string;
}): void {
  const command = normalizeString(input.command);
  logProcessLifecycle({
    event: 'kill_attempt',
    source: 'http.clock-managed-client-reaper',
    details: {
      daemonId: normalizeString(input.daemonId) || null,
      targetPid: input.pid,
      signal: input.signal,
      result: input.result,
      reason: input.reason,
      ...(input.clientType ? { clientType: normalizeString(input.clientType) || null } : {}),
      ...(input.commandHint ? { commandHint: normalizeString(input.commandHint) || null } : {}),
      ...(command ? { commandSnippet: command.slice(0, 180) } : {})
    }
  });
}

export function terminateManagedClientProcess(input: {
  daemonId: string;
  pid: number;
  commandHint?: string;
  clientType?: string;
}): boolean {
  const pid = normalizePid(input.pid);
  if (!pid) {
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid: null,
      signal: 'SIGTERM',
      result: 'skipped',
      reason: 'invalid_pid',
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return false;
  }
  if (pid === process.pid) {
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid,
      signal: 'SIGTERM',
      result: 'skipped',
      reason: 'self_pid',
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') {
      logManagedClientKillEvent({
        daemonId: input.daemonId,
        pid,
        signal: 'SIGTERM',
        result: 'success',
        reason: 'already_exited',
        clientType: input.clientType,
        commandHint: input.commandHint
      });
      return true;
    }
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid,
      signal: 'SIGTERM',
      result: 'failed',
      reason: `signal_check_failed:${String(code || 'unknown')}`,
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return false;
  }

  if (process.platform !== 'win32') {
    const command = readProcessCommand(pid);
    if (command) {
      if (isForbiddenCommand(command)) {
        logManagedClientKillEvent({
          daemonId: input.daemonId,
          pid,
          signal: 'SIGTERM',
          result: 'skipped',
          reason: 'forbidden_command',
          clientType: input.clientType,
          commandHint: input.commandHint,
          command
        });
        return false;
      }
      if (!matchesCommandHint(command, input.commandHint, input.clientType)) {
        logManagedClientKillEvent({
          daemonId: input.daemonId,
          pid,
          signal: 'SIGTERM',
          result: 'skipped',
          reason: 'command_mismatch',
          clientType: input.clientType,
          commandHint: input.commandHint,
          command
        });
        return false;
      }
    }
  }

  const isPidAlive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return code !== 'ESRCH';
    }
  };

  logManagedClientKillEvent({
    daemonId: input.daemonId,
    pid,
    signal: 'SIGTERM',
    result: 'attempt',
    reason: 'send_signal',
    clientType: input.clientType,
    commandHint: input.commandHint
  });

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') {
      logManagedClientKillEvent({
        daemonId: input.daemonId,
        pid,
        signal: 'SIGTERM',
        result: 'success',
        reason: 'already_exited',
        clientType: input.clientType,
        commandHint: input.commandHint
      });
      return true;
    }
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid,
      signal: 'SIGTERM',
      result: 'failed',
      reason: `term_failed:${String(code || 'unknown')}`,
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return false;
  }

  if (!isPidAlive()) {
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid,
      signal: 'SIGTERM',
      result: 'success',
      reason: 'signaled',
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return true;
  }

  logManagedClientKillEvent({
    daemonId: input.daemonId,
    pid,
    signal: 'SIGTERM',
    result: 'failed',
    reason: 'alive_after_term',
    clientType: input.clientType,
    commandHint: input.commandHint
  });

  logManagedClientKillEvent({
    daemonId: input.daemonId,
    pid,
    signal: 'SIGKILL',
    result: 'attempt',
    reason: 'term_escalation',
    clientType: input.clientType,
    commandHint: input.commandHint
  });

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') {
      logManagedClientKillEvent({
        daemonId: input.daemonId,
        pid,
        signal: 'SIGKILL',
        result: 'success',
        reason: 'already_exited',
        clientType: input.clientType,
        commandHint: input.commandHint
      });
      return true;
    }
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid,
      signal: 'SIGKILL',
      result: 'failed',
      reason: `kill_failed:${String(code || 'unknown')}`,
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return false;
  }

  if (!isPidAlive()) {
    logManagedClientKillEvent({
      daemonId: input.daemonId,
      pid,
      signal: 'SIGKILL',
      result: 'success',
      reason: 'signaled',
      clientType: input.clientType,
      commandHint: input.commandHint
    });
    return true;
  }

  logManagedClientKillEvent({
    daemonId: input.daemonId,
    pid,
    signal: 'SIGKILL',
    result: 'failed',
    reason: 'alive_after_kill',
    clientType: input.clientType,
    commandHint: input.commandHint
  });
  return false;
}
