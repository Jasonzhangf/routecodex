import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type {
  ClockConfigSnapshot,
  ClockReservation,
  ClockScheduleItem,
  ClockSessionMeta,
  ClockSessionState,
  ClockTask,
  ClockTaskRecurrence,
  ClockTaskSetter,
  ClockTaskUpdatePatch
} from './types.js';
import { ensureDir, readSessionDirEnv, resolveClockDir, resolveClockStateFile } from './paths.js';
import { cleanExpiredTasks, normalizeClockSessionMeta, nowMs } from './state.js';
import { readJsonFile, writeJsonFileAtomic } from './io.js';
import { loadClockSessionState } from './session-store.js';

const TMUX_SCOPE_PREFIX = 'tmux:';
const CLOCK_REMINDER_MERGE_WINDOW_MS = 5 * 60_000;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function isNonEmptyJsonObjectString(value: string): boolean {
  const normalized = value.trim();
  return normalized !== '{}' && normalized !== '[]' && normalized.length > 0;
}

function resolveLocalTimeZoneLabel(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone === 'Asia/Shanghai' || timeZone === 'Asia/Chongqing' || timeZone === 'Asia/Harbin' || timeZone === 'Asia/Urumqi') {
    return 'CST';
  }
  return '';
}

function formatLocalClockTimestamp(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    return new Date(0).toISOString();
  }
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  });
  const parts = formatter.formatToParts(date);
  const readPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const base = `${readPart('year')}-${readPart('month')}-${readPart('day')} ${readPart('hour')}:${readPart('minute')}:${readPart('second')}`;
  const label = resolveLocalTimeZoneLabel() || readPart('timeZoneName') || 'local';
  return `${base} ${label}`.trim();
}

function buildClockMdTemplateHint(): string {
  return [
    'clock.md 模板:',
    '可选自动停止：在顶部加 `Clock-Stop-When: no-open-tasks`；当无未完成任务时系统会自动停用当前会话 clock。',
    '重新 schedule/update 激活后，系统会自动清理该停止标记。',
    '## 背景',
    '## 当前阻塞点',
    '## 下次提醒要做的第一步',
    '## 不能忘的检查项',
    '## 建议内容示例',
    '- 背景：正在准备 llms 包发布，已完成 build 和本地验证',
    '- 当前阻塞点：等待 10 分钟后再检查 npm 包同步状态',
    '- 下次提醒要做的第一步：运行 npm view 检查新版本是否可见',
    '- 不能忘的检查项：确认 tag、版本号、release notes、install smoke test'
  ].join(' | ');
}

export function formatClockReminderText(task: Pick<
  ClockTask,
  'task' | 'dueAtMs' | 'createdAtMs' | 'setBy' | 'tool' | 'arguments' | 'urls' | 'paths' | 'deliveryCount' | 'recurrence'
>): string {
  const lines = [
    '[Clock Reminder]',
    `任务: ${String(task.task || '').trim() || '未命名任务'}`,
    `触发时间: ${formatLocalClockTimestamp(task.dueAtMs)}`,
    `设置人: ${task.setBy === 'agent' ? 'agent' : 'user'}`,
    `设置时间: ${formatLocalClockTimestamp(task.createdAtMs)}`,
    '复杂任务: 先查看并更新当前工作目录下的 clock.md',
    buildClockMdTemplateHint()
  ];
  if (task.tool) {
    lines.push(`建议工具: ${task.tool}`);
  }
  const argsText = task.arguments ? safeJson(task.arguments) : '';
  if (isNonEmptyJsonObjectString(argsText)) {
    lines.push(`参数: ${argsText}`);
  }
  if (Array.isArray(task.urls) && task.urls.length) {
    lines.push(`链接: ${task.urls.join(', ')}`);
  }
  if (Array.isArray(task.paths) && task.paths.length) {
    lines.push(`路径: ${task.paths.join(', ')}`);
  }
  const recurrence = normalizeRecurrence(task.recurrence);
  if (recurrence) {
    const runCount = Math.max(0, Number(task.deliveryCount) || 0);
    const recurrenceSummary =
      recurrence.kind === 'interval'
        ? `interval(${recurrence.everyMinutes}m) ${runCount}/${recurrence.maxRuns}`
        : `${recurrence.kind} ${runCount}/${recurrence.maxRuns}`;
    lines.push(`重复: ${recurrenceSummary}`);
  }
  return lines.join('\n');
}

function appendClockTaskDetails(
  lines: string[],
  task: Pick<
    ClockTask,
    'task' | 'dueAtMs' | 'createdAtMs' | 'setBy' | 'tool' | 'arguments' | 'urls' | 'paths' | 'deliveryCount' | 'recurrence'
  >,
  prefix = ''
): void {
  lines.push(`${prefix}任务: ${String(task.task || '').trim() || '未命名任务'}`);
  lines.push(`${prefix}触发时间: ${formatLocalClockTimestamp(task.dueAtMs)}`);
  lines.push(`${prefix}设置人: ${task.setBy === 'agent' ? 'agent' : 'user'}`);
  lines.push(`${prefix}设置时间: ${formatLocalClockTimestamp(task.createdAtMs)}`);
  if (task.tool) {
    lines.push(`${prefix}建议工具: ${task.tool}`);
  }
  const argsText = task.arguments ? safeJson(task.arguments) : '';
  if (isNonEmptyJsonObjectString(argsText)) {
    lines.push(`${prefix}参数: ${argsText}`);
  }
  if (Array.isArray(task.urls) && task.urls.length) {
    lines.push(`${prefix}链接: ${task.urls.join(', ')}`);
  }
  if (Array.isArray(task.paths) && task.paths.length) {
    lines.push(`${prefix}路径: ${task.paths.join(', ')}`);
  }
  const recurrence = normalizeRecurrence(task.recurrence);
  if (recurrence) {
    const runCount = Math.max(0, Number(task.deliveryCount) || 0);
    const recurrenceSummary =
      recurrence.kind === 'interval'
        ? `interval(${recurrence.everyMinutes}m) ${runCount}/${recurrence.maxRuns}`
        : `${recurrence.kind} ${runCount}/${recurrence.maxRuns}`;
    lines.push(`${prefix}重复: ${recurrenceSummary}`);
  }
}

export function selectClockReminderDeliveryBatch(tasks: ClockTask[]): ClockTask[] {
  if (!Array.isArray(tasks) || tasks.length < 1) {
    return [];
  }
  const sorted = tasks
    .filter((task) => task && typeof task === 'object' && Number.isFinite(task.dueAtMs))
    .slice()
    .sort((a, b) => a.dueAtMs - b.dueAtMs);
  if (sorted.length < 2) {
    return sorted;
  }
  const firstDueAtMs = sorted[0].dueAtMs;
  return sorted.filter((task) => task.dueAtMs - firstDueAtMs <= CLOCK_REMINDER_MERGE_WINDOW_MS);
}

export function formatClockReminderBatchText(tasks: ClockTask[]): string {
  const batch = selectClockReminderDeliveryBatch(tasks);
  if (batch.length < 1) {
    return '';
  }
  if (batch.length === 1) {
    return formatClockReminderText(batch[0]);
  }

  const first = batch[0];
  const last = batch[batch.length - 1];
  const lines = [
    '[Clock Reminder]',
    `本轮有 ${batch.length} 个到期任务（触发时间间隔在 5 分钟内，已合并发送）。`,
    `最早触发时间: ${formatLocalClockTimestamp(first.dueAtMs)}`,
    `最晚触发时间: ${formatLocalClockTimestamp(last.dueAtMs)}`,
    '复杂任务: 先查看并更新当前工作目录下的 clock.md',
    buildClockMdTemplateHint()
  ];

  batch.forEach((task, index) => {
    lines.push(``);
    lines.push(`${index + 1}.`);
    appendClockTaskDetails(lines, task, '   ');
  });

  return lines.join('\n');
}

function buildTaskId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `task_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

function extractTmuxSessionIdFromScope(sessionId: string): string | undefined {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalized.startsWith(TMUX_SCOPE_PREFIX)) {
    return undefined;
  }
  const tmuxSessionId = normalized.slice(TMUX_SCOPE_PREFIX.length).trim();
  return tmuxSessionId || undefined;
}

function normalizeRecurrence(raw: unknown): ClockTaskRecurrence | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const rawKind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
  const kind = rawKind === 'daily' || rawKind === 'weekly' || rawKind === 'interval'
    ? rawKind
    : undefined;
  const maxRunsRaw = Number(record.maxRuns);
  const maxRuns = Number.isFinite(maxRunsRaw) ? Math.floor(maxRunsRaw) : NaN;
  if (!kind || !Number.isFinite(maxRuns) || maxRuns <= 0) {
    return undefined;
  }
  if (kind === 'interval') {
    const everyRaw = Number(record.everyMinutes);
    const everyMinutes = Number.isFinite(everyRaw) ? Math.floor(everyRaw) : NaN;
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      return undefined;
    }
    return { kind, maxRuns, everyMinutes };
  }
  return { kind, maxRuns };
}

function normalizeTaskSetter(raw: unknown): ClockTaskSetter {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'agent') {
    return 'agent';
  }
  return 'user';
}

function resolveRecurringStepMs(recurrence: ClockTaskRecurrence): number | null {
  if (recurrence.kind === 'daily') {
    return 24 * 60 * 60_000;
  }
  if (recurrence.kind === 'weekly') {
    return 7 * 24 * 60 * 60_000;
  }
  if (recurrence.kind === 'interval') {
    const minutes = Number(recurrence.everyMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return null;
    }
    return Math.floor(minutes) * 60_000;
  }
  return null;
}

function computeNextRecurringDueAtMs(currentDueAtMs: number, recurrence: ClockTaskRecurrence, atMs: number): number | null {
  if (!Number.isFinite(currentDueAtMs)) {
    return null;
  }
  const stepMs = resolveRecurringStepMs(recurrence);
  if (!stepMs || stepMs <= 0) {
    return null;
  }
  if (recurrence.kind === 'interval') {
    const anchor = Math.max(Math.floor(currentDueAtMs), Math.floor(atMs));
    const next = anchor + stepMs;
    return Number.isFinite(next) ? Math.floor(next) : null;
  }
  let next = Math.floor(currentDueAtMs) + stepMs;
  const ceiling = Math.max(atMs, Math.floor(currentDueAtMs)) + stepMs * 100_000;
  while (next <= atMs && next < ceiling) {
    next += stepMs;
  }
  if (!Number.isFinite(next) || next <= atMs) {
    return null;
  }
  return Math.floor(next);
}

function nextClockTaskRevision(meta: ClockSessionMeta): ClockSessionMeta {
  return {
    ...meta,
    taskRevision: Math.max(0, meta.taskRevision) + 1
  };
}

function hasMeaningfulClockMeta(meta: ClockSessionMeta): boolean {
  return meta.taskRevision > 0 || meta.listedRevision >= 0 || Number.isFinite(meta.lastListAtMs);
}

async function persistClockSessionState(filePath: string, state: ClockSessionState): Promise<void> {
  if (!state.tasks.length && !hasMeaningfulClockMeta(normalizeClockSessionMeta(state.meta))) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeJsonFileAtomic(filePath, state);
}

export function hasObservedClockList(state: ClockSessionState): boolean {
  const meta = normalizeClockSessionMeta(state.meta);
  return meta.listedRevision >= 0 && meta.listedRevision === meta.taskRevision;
}

export async function markClockListObserved(
  sessionId: string,
  config: ClockConfigSnapshot
): Promise<ClockSessionState> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    throw new Error('clock: missing ROUTECODEX_SESSION_DIR');
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error('clock: invalid sessionId');
  }
  await ensureDir(path.dirname(filePath));

  const at = nowMs();
  const state = await loadClockSessionState(sessionId, config);
  const meta = normalizeClockSessionMeta(state.meta);
  const next: ClockSessionState = {
    version: 1,
    sessionId,
    ...(state.tmuxSessionId ? { tmuxSessionId: state.tmuxSessionId } : {}),
    tasks: state.tasks.slice(),
    updatedAtMs: at,
    meta: {
      ...meta,
      listedRevision: meta.taskRevision,
      lastListAtMs: at
    }
  };
  await persistClockSessionState(filePath, next);
  return next;
}

export function findNearbyClockTasks(
  tasks: ClockTask[],
  anchorTask: ClockTask,
  toleranceMs: number
): ClockTask[] {
  const windowMs = Math.max(0, Math.floor(toleranceMs));
  if (!Number.isFinite(anchorTask?.dueAtMs) || windowMs <= 0) {
    return [];
  }
  return tasks
    .filter((task) => task && task.taskId !== anchorTask.taskId)
    .filter((task) => Number.isFinite(task.dueAtMs))
    .filter((task) => Math.abs(task.dueAtMs - anchorTask.dueAtMs) <= windowMs)
    .sort((a, b) => a.dueAtMs - b.dueAtMs);
}

export function parseDueAtMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

export async function listClockSessionIds(): Promise<string[]> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return [];
  }
  const clockDir = resolveClockDir(sessionDir);
  const entries = await fs.readdir(clockDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const sessionIds = await Promise.all(entries
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name.endsWith('.json'))
    .filter((entry) => entry.name !== 'ntp-state.json')
    .filter((entry) => (typeof entry.isFile === 'function' ? entry.isFile() : true))
    .map(async (entry) => {
      const fallbackSessionId = entry.name.slice(0, -'.json'.length).trim();
      try {
        const raw = await readJsonFile(path.join(clockDir, entry.name));
        const sessionId =
          raw && typeof raw === 'object' && typeof (raw as { sessionId?: unknown }).sessionId === 'string'
            ? String((raw as { sessionId?: unknown }).sessionId).trim()
            : '';
        return sessionId || fallbackSessionId;
      } catch {
        return fallbackSessionId;
      }
    }));
  return Array.from(new Set(sessionIds.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export async function listClockTasks(sessionId: string, config: ClockConfigSnapshot): Promise<ClockTask[]> {
  const state = await loadClockSessionState(sessionId, config);
  return state.tasks.slice();
}

export async function scheduleClockTasks(
  sessionId: string,
  items: ClockScheduleItem[],
  config: ClockConfigSnapshot
): Promise<ClockTask[]> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    throw new Error('clock: missing ROUTECODEX_SESSION_DIR');
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error('clock: invalid sessionId');
  }
  await ensureDir(path.dirname(filePath));

  const at = nowMs();
  const existing = await loadClockSessionState(sessionId, config);
  const cleaned = cleanExpiredTasks(existing.tasks, config, at);
  const existingMeta = normalizeClockSessionMeta(existing.meta);

  const scheduled: ClockTask[] = [];
  for (const item of items) {
    const text =
      typeof item.prompt === 'string' && item.prompt.trim()
        ? item.prompt.trim()
        : typeof item.task === 'string'
          ? item.task.trim()
          : '';
    const dueAtMs = item.dueAtMs;
    if (!text || !Number.isFinite(dueAtMs)) {
      continue;
    }
    const recurrence = normalizeRecurrence(item.recurrence);
    if (item.recurrence && !recurrence) {
      continue;
    }
    const setBy = normalizeTaskSetter(item.setBy);
    const taskId = buildTaskId();
    scheduled.push({
      taskId,
      sessionId,
      dueAtMs: Math.floor(dueAtMs),
      createdAtMs: at,
      updatedAtMs: at,
      setBy,
      prompt: text,
      task: text,
      ...(item.tool ? { tool: item.tool } : {}),
      ...(item.arguments ? { arguments: item.arguments } : {}),
      ...(Array.isArray(item.urls) && item.urls.length ? { urls: item.urls } : {}),
      ...(Array.isArray(item.paths) && item.paths.length ? { paths: item.paths } : {}),
      ...(item.notBeforeRequestId ? { notBeforeRequestId: item.notBeforeRequestId } : {}),
      ...(recurrence ? { recurrence } : {}),
      deliveryCount: 0
    });
  }
  const nextTasks = cleanExpiredTasks([...cleaned, ...scheduled], config, at);
  const next: ClockSessionState = {
    version: 1,
    sessionId,
    ...(extractTmuxSessionIdFromScope(sessionId) ? { tmuxSessionId: extractTmuxSessionIdFromScope(sessionId) } : {}),
    tasks: nextTasks,
    updatedAtMs: at,
    meta: scheduled.length ? nextClockTaskRevision(existingMeta) : existingMeta
  };
  await persistClockSessionState(filePath, next);
  return scheduled;
}

export async function updateClockTask(
  sessionId: string,
  taskId: string,
  patch: ClockTaskUpdatePatch,
  config: ClockConfigSnapshot
): Promise<ClockTask | null> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    throw new Error('clock: missing ROUTECODEX_SESSION_DIR');
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error('clock: invalid sessionId');
  }
  await ensureDir(path.dirname(filePath));

  const at = nowMs();
  const state = await loadClockSessionState(sessionId, config);
  const cleaned = cleanExpiredTasks(state.tasks, config, at);
  const stateMeta = normalizeClockSessionMeta(state.meta);
  const index = cleaned.findIndex((item) => item.taskId === taskId);
  if (index < 0) {
    return null;
  }

  const current = cleaned[index];
  const nextTask: ClockTask = {
    ...current,
    updatedAtMs: at
  };

  if (typeof patch.dueAtMs === 'number' && Number.isFinite(patch.dueAtMs)) {
    nextTask.dueAtMs = Math.floor(patch.dueAtMs);
    delete (nextTask as any).deliveredAtMs;
  }

  if (typeof patch.task === 'string' && patch.task.trim()) {
    nextTask.prompt = patch.task.trim();
    nextTask.task = patch.task.trim();
  }

  if (patch.tool === null) {
    delete (nextTask as any).tool;
  } else if (typeof patch.tool === 'string' && patch.tool.trim()) {
    nextTask.tool = patch.tool.trim();
  }

  if (patch.arguments === null) {
    delete (nextTask as any).arguments;
  } else if (patch.arguments && typeof patch.arguments === 'object' && !Array.isArray(patch.arguments)) {
    nextTask.arguments = patch.arguments as Record<string, unknown>;
  }

  if (patch.urls === null) {
    delete (nextTask as any).urls;
  } else if (Array.isArray(patch.urls)) {
    nextTask.urls = patch.urls
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => String(entry).trim());
  }

  if (patch.paths === null) {
    delete (nextTask as any).paths;
  } else if (Array.isArray(patch.paths)) {
    nextTask.paths = patch.paths
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => String(entry).trim());
  }

  if (patch.notBeforeRequestId === null) {
    delete (nextTask as any).notBeforeRequestId;
  } else if (typeof patch.notBeforeRequestId === 'string' && patch.notBeforeRequestId.trim()) {
    nextTask.notBeforeRequestId = patch.notBeforeRequestId.trim();
  }

  if (patch.recurrence === null) {
    delete (nextTask as any).recurrence;
  } else if (patch.recurrence) {
    const recurrence = normalizeRecurrence(patch.recurrence);
    if (!recurrence) {
      return null;
    }
    nextTask.recurrence = recurrence;
    delete (nextTask as any).deliveredAtMs;
  }

  if (patch.resetDelivery) {
    nextTask.deliveryCount = 0;
    delete (nextTask as any).deliveredAtMs;
  }

  cleaned[index] = nextTask;
  const next: ClockSessionState = {
    version: 1,
    sessionId,
    ...(state.tmuxSessionId ? { tmuxSessionId: state.tmuxSessionId } : {}),
    tasks: cleaned,
    updatedAtMs: at,
    meta: nextClockTaskRevision(stateMeta)
  };
  await persistClockSessionState(filePath, next);
  return nextTask;
}

export async function cancelClockTask(sessionId: string, taskId: string, config: ClockConfigSnapshot): Promise<boolean> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    throw new Error('clock: missing ROUTECODEX_SESSION_DIR');
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error('clock: invalid sessionId');
  }
  await ensureDir(path.dirname(filePath));

  const at = nowMs();
  const state = await loadClockSessionState(sessionId, config);
  const cleaned = cleanExpiredTasks(state.tasks, config, at);
  const stateMeta = normalizeClockSessionMeta(state.meta);
  const nextTasks = cleaned.filter((t) => t.taskId !== taskId);
  const removed = nextTasks.length !== cleaned.length;
  const next: ClockSessionState = {
    version: 1,
    sessionId,
    ...(state.tmuxSessionId ? { tmuxSessionId: state.tmuxSessionId } : {}),
    tasks: nextTasks,
    updatedAtMs: at,
    meta: removed ? nextClockTaskRevision(stateMeta) : stateMeta
  };
  await persistClockSessionState(filePath, next);
  return removed;
}

export async function clearClockTasks(sessionId: string, config: ClockConfigSnapshot): Promise<number> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    throw new Error('clock: missing ROUTECODEX_SESSION_DIR');
  }
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error('clock: invalid sessionId');
  }
  await ensureDir(path.dirname(filePath));

  const at = nowMs();
  const state = await loadClockSessionState(sessionId, config);
  const removedCount = state.tasks.length;
  const meta = normalizeClockSessionMeta(state.meta);
  const next: ClockSessionState = {
    version: 1,
    sessionId,
    ...(state.tmuxSessionId ? { tmuxSessionId: state.tmuxSessionId } : {}),
    tasks: [],
    updatedAtMs: at,
    meta: removedCount > 0 ? nextClockTaskRevision(meta) : meta
  };
  await persistClockSessionState(filePath, next);
  return removedCount;
}

function isRecurringTaskPending(task: ClockTask): boolean {
  const recurrence = normalizeRecurrence((task as any).recurrence);
  if (!recurrence) {
    return false;
  }
  const deliveryCount =
    typeof task.deliveryCount === 'number' && Number.isFinite(task.deliveryCount)
      ? Math.max(0, Math.floor(task.deliveryCount))
      : 0;
  return deliveryCount < recurrence.maxRuns;
}

export function selectDueUndeliveredTasks(tasks: ClockTask[], config: ClockConfigSnapshot, atMs: number): ClockTask[] {
  const due: ClockTask[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;

    const recurringPending = isRecurringTaskPending(task);
    if (!recurringPending && task.deliveredAtMs !== undefined) continue;

    if (typeof (task as any).notBeforeRequestId === 'string' && (task as any).notBeforeRequestId.trim().length) {
      // notBeforeRequestId is evaluated by reserveDueTasksForRequest, which passes requestId.
      // Keep legacy callers working by ignoring this guard here (default behavior).
    }
    if (!Number.isFinite(task.dueAtMs)) continue;
    if (atMs < task.dueAtMs - config.dueWindowMs) continue;
    if (!recurringPending && atMs > task.dueAtMs + config.retentionMs) continue;
    due.push(task);
  }
  due.sort((a, b) => a.dueAtMs - b.dueAtMs);
  return due;
}

export function findNextUndeliveredDueAtMs(tasks: ClockTask[], atMs: number): number | null {
  let next: number | null = null;
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const recurringPending = isRecurringTaskPending(task);
    if (!recurringPending && task.deliveredAtMs !== undefined) continue;
    if (!Number.isFinite(task.dueAtMs)) continue;
    if (task.dueAtMs < atMs) {
      // keep past due tasks as "next" too (will be due immediately)
    }
    if (next === null || task.dueAtMs < next) {
      next = task.dueAtMs;
    }
  }
  return next;
}

export async function reserveDueTasksForRequest(args: {
  reservationId: string;
  sessionId: string;
  config: ClockConfigSnapshot;
  requestId?: string;
}): Promise<{ reservation: ClockReservation | null; injectText?: string }> {
  const state = await loadClockSessionState(args.sessionId, args.config);
  const at = nowMs();
  const dueAll = selectDueUndeliveredTasks(state.tasks, args.config, at);
  const requestId = typeof args.requestId === 'string' && args.requestId.trim().length ? args.requestId.trim() : '';
  const isSameRequestChain = (guardedRequestId: string, currentRequestId: string): boolean => {
    const guarded = guardedRequestId.trim();
    if (!guarded) return false;
    return currentRequestId === guarded || currentRequestId.startsWith(`${guarded}:`);
  };
  const due =
    requestId
      ? dueAll.filter((t) => {
        const guarded =
          typeof (t as any).notBeforeRequestId === 'string' ? String((t as any).notBeforeRequestId).trim() : '';
        if (!guarded) {
          return true;
        }
        return !isSameRequestChain(guarded, requestId);
      })
      : dueAll;
  if (!due.length) {
    return { reservation: null };
  }
  const deliveryBatch = selectClockReminderDeliveryBatch(due);
  const taskIds = deliveryBatch.map((t) => t.taskId);
  const reservation: ClockReservation = {
    reservationId: args.reservationId,
    sessionId: args.sessionId,
    taskIds,
    reservedAtMs: at
  };
  const injectText = formatClockReminderBatchText(deliveryBatch);
  return { reservation, injectText };
}

export async function commitClockReservation(reservation: ClockReservation, config: ClockConfigSnapshot): Promise<void> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    return;
  }
  const filePath = resolveClockStateFile(sessionDir, reservation.sessionId);
  if (!filePath) {
    return;
  }
  const at = nowMs();
  const state = await loadClockSessionState(reservation.sessionId, config);
  const cleaned = cleanExpiredTasks(state.tasks, config, at);
  const reservedSet = new Set(reservation.taskIds);
  let touched = false;
  const nextTasks: ClockTask[] = [];

  for (const task of cleaned) {
    if (!reservedSet.has(task.taskId)) {
      nextTasks.push(task);
      continue;
    }

    touched = true;
    const currentCount =
      typeof task.deliveryCount === 'number' && Number.isFinite(task.deliveryCount)
        ? Math.max(0, Math.floor(task.deliveryCount))
        : 0;
    const nextCount = currentCount + 1;
    const recurrence = normalizeRecurrence((task as any).recurrence);

    if (recurrence) {
      if (nextCount >= recurrence.maxRuns) {
        continue;
      }
      const nextDueAtMs = computeNextRecurringDueAtMs(task.dueAtMs, recurrence, at);
      if (!Number.isFinite(nextDueAtMs as number)) {
        continue;
      }
      nextTasks.push({
        ...task,
        dueAtMs: nextDueAtMs as number,
        deliveryCount: nextCount,
        updatedAtMs: at,
        recurrence,
        deliveredAtMs: undefined
      });
      continue;
    }

    if (task.deliveredAtMs !== undefined) {
      nextTasks.push(task);
      continue;
    }

    nextTasks.push({
      ...task,
      deliveredAtMs: at,
      deliveryCount: nextCount,
      updatedAtMs: at
    });
  }

  if (!touched) {
    return;
  }

  const next: ClockSessionState = {
    version: 1,
    sessionId: reservation.sessionId,
    ...(state.tmuxSessionId
      ? { tmuxSessionId: state.tmuxSessionId }
      : extractTmuxSessionIdFromScope(reservation.sessionId)
        ? { tmuxSessionId: extractTmuxSessionIdFromScope(reservation.sessionId) }
        : {}),
    tasks: nextTasks,
    updatedAtMs: at
  };
  await ensureDir(path.dirname(filePath));
  if (!next.tasks.length) {
    await fs.rm(filePath, { force: true });
  } else {
    await writeJsonFileAtomic(filePath, next);
  }
}
