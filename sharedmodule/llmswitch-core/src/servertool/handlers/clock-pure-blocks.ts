import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ClockScheduleItem, ClockTask, ClockTaskRecurrence } from '../clock/task-store.js';
import { parseDueAtMs } from '../clock/task-store.js';
import { cloneJson } from '../server-side-tools.js';
import type { ToolCall } from '../types.js';
import {
  buildToolMessagesFromToolOutputs as buildToolMessagesFromToolOutputsShared,
  extractAssistantMessageFromChatLike as extractAssistantMessageFromChatLikeShared
} from './followup-message-blocks.js';

type PlainObject = Record<string, unknown>;

type NormalizeScheduleItemsResult =
  | { ok: true; items: ClockScheduleItem[]; message?: string }
  | { ok: false; items: ClockScheduleItem[]; message: string };

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function parseDueAtFromUnknown(value: unknown): number | null {
  if (typeof value === 'string') {
    return parseDueAtMs(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return null;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? '');
  }
}

function normalizeTaskSetBy(value: unknown): 'user' | 'agent' | undefined {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === 'agent') {
    return 'agent';
  }
  if (normalized === 'user') {
    return 'user';
  }
  return undefined;
}

export function asPlainObject(value: unknown): PlainObject {
  return isPlainObject(value) ? value : {};
}

export function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseRecurrenceFromRecord(record: Record<string, unknown>): ClockTaskRecurrence | undefined {
  const raw = record.recurrence;
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const kind = toTrimmedString(raw.kind).toLowerCase();
  const maxRunsRaw = Number(raw.maxRuns);
  const maxRuns = Number.isFinite(maxRunsRaw) ? Math.floor(maxRunsRaw) : NaN;
  if (maxRuns <= 0) {
    return undefined;
  }
  if (kind === 'daily' || kind === 'weekly') {
    return { kind, maxRuns };
  }
  if (kind === 'interval') {
    const everyMinutesRaw = Number(raw.everyMinutes);
    const everyMinutes = Number.isFinite(everyMinutesRaw) ? Math.floor(everyMinutesRaw) : NaN;
    if (everyMinutes <= 0) {
      return undefined;
    }
    return { kind, maxRuns, everyMinutes };
  }
  return undefined;
}

function normalizeSingleScheduleItem(entry: unknown): ClockScheduleItem | null {
  if (!isPlainObject(entry)) {
    return null;
  }
  const dueAtMs =
    parseDueAtFromUnknown(entry.dueAt) ??
    parseDueAtFromUnknown(entry.time) ??
    parseDueAtFromUnknown(entry.dueAtMs);
  const task = toTrimmedString(entry.task) || toTrimmedString(entry.message);
  if (!Number.isFinite(dueAtMs) || !task) {
    return null;
  }
  const normalized: ClockScheduleItem = {
    dueAtMs,
    task
  };
  const prompt = toTrimmedString(entry.prompt);
  if (prompt) {
    normalized.prompt = prompt;
  }
  const setBy = normalizeTaskSetBy(entry.setBy);
  if (setBy) {
    normalized.setBy = setBy;
  }
  const tool = toTrimmedString(entry.tool);
  if (tool) {
    normalized.tool = tool;
  }
  if (isPlainObject(entry.arguments)) {
    normalized.arguments = cloneJson(entry.arguments);
  }
  const urls = toStringArray(entry.urls);
  if (urls) {
    normalized.urls = urls;
  }
  const paths = toStringArray(entry.paths);
  if (paths) {
    normalized.paths = paths;
  }
  const notBeforeRequestId = toTrimmedString(entry.notBeforeRequestId);
  if (notBeforeRequestId) {
    normalized.notBeforeRequestId = notBeforeRequestId;
  }
  const recurrence = parseRecurrenceFromRecord(entry);
  if (recurrence) {
    normalized.recurrence = recurrence;
  }
  return normalized;
}

export function normalizeScheduleItems(parsedArgs: Record<string, unknown>): NormalizeScheduleItemsResult {
  const rawItems = Array.isArray(parsedArgs.items)
    ? parsedArgs.items
    : isPlainObject(parsedArgs.item)
      ? [parsedArgs.item]
      : isPlainObject(parsedArgs)
        ? [parsedArgs]
        : [];
  const items = rawItems
    .map((entry) => normalizeSingleScheduleItem(entry))
    .filter((entry): entry is ClockScheduleItem => Boolean(entry));
  if (items.length < 1) {
    return {
      ok: false,
      items: [],
      message: 'clock.schedule requires items[0] with dueAt/task'
    };
  }
  return { ok: true, items };
}

export function mapTaskForTool(task: ClockTask): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    taskId: task.taskId,
    sessionId: task.sessionId,
    task: task.task,
    dueAtMs: task.dueAtMs,
    dueAt: new Date(task.dueAtMs).toISOString(),
    createdAtMs: task.createdAtMs,
    setAt: new Date(task.createdAtMs).toISOString(),
    updatedAtMs: task.updatedAtMs,
    updatedAt: new Date(task.updatedAtMs).toISOString(),
    setBy: task.setBy,
    deliveryCount: task.deliveryCount
  };
  if (typeof task.prompt === 'string' && task.prompt.trim()) {
    mapped.prompt = task.prompt;
  }
  if (typeof task.tool === 'string' && task.tool.trim()) {
    mapped.tool = task.tool;
  }
  if (isPlainObject(task.arguments)) {
    mapped.arguments = cloneJson(task.arguments);
  }
  if (Array.isArray(task.urls) && task.urls.length > 0) {
    mapped.urls = task.urls.slice();
  }
  if (Array.isArray(task.paths) && task.paths.length > 0) {
    mapped.paths = task.paths.slice();
  }
  if (typeof task.deliveredAtMs === 'number' && Number.isFinite(task.deliveredAtMs)) {
    mapped.deliveredAtMs = task.deliveredAtMs;
    mapped.deliveredAt = new Date(task.deliveredAtMs).toISOString();
  }
  if (typeof task.notBeforeRequestId === 'string' && task.notBeforeRequestId.trim()) {
    mapped.notBeforeRequestId = task.notBeforeRequestId;
  }
  if (task.recurrence) {
    mapped.recurrence = cloneJson(task.recurrence);
  }
  return mapped;
}

export function injectClockToolOutput(
  base: JsonObject,
  toolCall: ToolCall,
  content: unknown
): JsonObject {
  const cloned = cloneJson(base);
  const existingOutputs = Array.isArray((cloned as { tool_outputs?: unknown }).tool_outputs)
    ? ((cloned as { tool_outputs: JsonValue[] }).tool_outputs as JsonValue[])
    : [];
  (cloned as Record<string, unknown>).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: 'clock',
      content: stringifyContent(content)
    }
  ];
  return cloned;
}

export function stripClockStopMarkerFromText(raw: string): { changed: boolean; updated: string } {
  const source = typeof raw === 'string' ? raw : '';
  const next = source.replace(/^[ \t]*Clock-Stop-When:[^\n]*(?:\n|\r\n)?/gim, '');
  return {
    changed: next !== source,
    updated: next
  };
}

export function extractAssistantMessageFromChatLike(chatResponse: JsonObject): JsonObject | null {
  return extractAssistantMessageFromChatLikeShared(chatResponse);
}

export function buildToolMessagesFromToolOutputs(chatResponse: JsonObject): JsonObject[] {
  return buildToolMessagesFromToolOutputsShared(chatResponse);
}
