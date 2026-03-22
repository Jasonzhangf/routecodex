import fs from 'node:fs/promises';
import path from 'node:path';

import {
  setClockRuntimeHooksSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { injectSessionClientPromptWithResult } from './session-client-registry.js';
import { appendTmuxInjectionHistoryEvent } from './tmux-injection-history.js';
import { evaluateTmuxScopeCleanup } from './tmux-scope-cleanup-policy.js';
import {
  isTmuxSessionAlive,
  resolveTmuxSessionWorkingDirectory
} from './tmux-session-probe.js';

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function shouldCleanupClockSession(reasonRaw: unknown, tmuxSessionId: string): boolean {
  return evaluateTmuxScopeCleanup({
    mode: 'runtime_failure',
    tmuxSessionId,
    reason: reasonRaw,
    isTmuxSessionAlive
  }).cleanupTmuxScope;
}

function parseClockStopWhenFromText(text: string): 'no-open-tasks' | 'never' | undefined {
  const match = text.match(/^\s*Clock-Stop-When:\s*(.+?)\s*$/im);
  if (!match) {
    return undefined;
  }
  const normalized = String(match[1] || '').trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'no-open-tasks' || normalized === 'no_open_tasks') {
    return 'no-open-tasks';
  }
  if (normalized === 'never' || normalized === 'off' || normalized === 'disabled') {
    return 'never';
  }
  return undefined;
}

function countChecklistTasks(text: string): { open: number; closed: number } {
  let open = 0;
  let closed = 0;
  let inCodeFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (/^\s*[-*+]\s*\[\s\]\s+/.test(line)) {
      open += 1;
      continue;
    }
    if (/^\s*[-*+]\s*\[[xX]\]\s+/.test(line)) {
      closed += 1;
      continue;
    }
  }
  return { open, closed };
}

async function readClockStopContext(workdir: string): Promise<{
  clockFile: string;
  clockStopWhen?: 'no-open-tasks' | 'never';
  checklistOpenCount: number;
  checklistTotalCount: number;
} | null> {
  const clockFile = path.join(workdir, 'clock.md');
  let raw = '';
  try {
    raw = await fs.readFile(clockFile, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const checklist = countChecklistTasks(raw);
  return {
    clockFile,
    clockStopWhen: parseClockStopWhenFromText(raw),
    checklistOpenCount: checklist.open,
    checklistTotalCount: checklist.open + checklist.closed
  };
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
        void appendTmuxInjectionHistoryEvent({
          source: 'clock',
          outcome: 'failed',
          reason: 'tmux_session_required'
        });
        return { ok: false, cleanupSession: true, reason: 'tmux_session_required' };
      }

      const injectText = readString(request?.injectText);
      if (!injectText) {
        void appendTmuxInjectionHistoryEvent({
          source: 'clock',
          outcome: 'failed',
          tmuxSessionId,
          sessionId: readString(request?.sessionId),
          reason: 'empty_text'
        });
        return { ok: false, reason: 'empty_text' };
      }

      const workdir = resolveTmuxSessionWorkingDirectory(tmuxSessionId);
      if (workdir) {
        try {
          const clockContext = await readClockStopContext(workdir);
          if (clockContext?.clockStopWhen === 'no-open-tasks') {
            if (clockContext.checklistTotalCount < 1) {
              void appendTmuxInjectionHistoryEvent({
                source: 'clock',
                outcome: 'disabled',
                tmuxSessionId,
                sessionId: readString(request?.sessionId),
                reason: 'clock_no_tasks'
              });
              return { ok: false, cleanupSession: true, reason: 'clock_no_tasks' };
            }
            if (clockContext.checklistOpenCount < 1) {
              void appendTmuxInjectionHistoryEvent({
                source: 'clock',
                outcome: 'disabled',
                tmuxSessionId,
                sessionId: readString(request?.sessionId),
                reason: 'clock_all_tasks_completed'
              });
              return { ok: false, cleanupSession: true, reason: 'clock_all_tasks_completed' };
            }
          }
        } catch {
          // best-effort: skip clock.md stop-check on read errors.
        }
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
        void appendTmuxInjectionHistoryEvent({
          source: 'clock',
          outcome: 'triggered',
          tmuxSessionId,
          sessionId: readString(request?.sessionId),
          requestId: `clock:${readString((request?.task as Record<string, unknown> | undefined)?.taskId) || 'task'}`
        });
        return { ok: true };
      }

      const reason = readString(injectResult.reason) || 'inject_failed';
      if (shouldCleanupClockSession(reason, tmuxSessionId)) {
        void appendTmuxInjectionHistoryEvent({
          source: 'clock',
          outcome: 'disabled',
          tmuxSessionId,
          sessionId: readString(request?.sessionId),
          reason
        });
        return { ok: false, reason };
      }
      void appendTmuxInjectionHistoryEvent({
        source: 'clock',
        outcome: 'failed',
        tmuxSessionId,
        sessionId: readString(request?.sessionId),
        reason
      });
      return { ok: false, reason };
    }
  });
}

export async function clearClockRuntimeHooks(): Promise<void> {
  await setClockRuntimeHooksSnapshot(undefined);
}
