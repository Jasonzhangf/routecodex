import fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import {
  cancelClockTask,
  clearClockTasks,
  findNearbyClockTasks,
  hasObservedClockList,
  listClockTasks,
  loadClockSessionState,
  markClockListObserved,
  resolveClockConfig,
  parseDueAtMs,
  scheduleClockTasks,
  startClockDaemonIfNeeded,
  updateClockTask,
  type ClockScheduleItem,
  type ClockTask,
  type ClockTaskRecurrence,
  type ClockTaskUpdatePatch
} from '../clock/task-store.js';
import { getClockTimeSnapshot } from '../clock/ntp.js';
import { nowMs } from '../clock/state.js';
import { logClock } from '../clock/log.js';
import { resolveClockSessionScope } from '../clock/session-scope.js';
import { resolveWorkingDirectoryFromAdapterContextOrFallback } from './memory/cache-writer.js';

const FLOW_ID = 'clock_flow';
const CLOCK_LIST_REQUIRED_MESSAGE =
  'clock.schedule requires clock.list immediately before creating a new reminder. List existing reminders first, and prefer clock.update when you can edit an existing reminder instead of creating another one.';
const CLOCK_NEARBY_REMINDER_WINDOW_MS = 5 * 60_000;

let fallbackClockToolCallSeq = 0;

function ensureClockToolCall(toolCall: ToolCall | undefined, requestId: string): ToolCall | null {
  if (!toolCall || toolCall.name !== 'clock') {
    return null;
  }
  const existingId = typeof toolCall.id === 'string' ? toolCall.id.trim() : '';
  if (existingId) {
    return toolCall;
  }
  fallbackClockToolCallSeq += 1;
  const reqToken = String(requestId || 'req').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'req';
  return {
    ...toolCall,
    id: `call_clock_fallback_${reqToken}_${fallbackClockToolCallSeq}`
  };
}

function extractAssistantMessageFromChatLike(chatResponse: JsonObject): JsonObject | null {
  if (!chatResponse || typeof chatResponse !== 'object') {
    return null;
  }
  const choices = Array.isArray((chatResponse as any).choices) ? ((chatResponse as any).choices as unknown[]) : [];
  if (!choices.length) {
    return null;
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return null;
  }
  const message = (first as any).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  const role = typeof (message as any).role === 'string' ? String((message as any).role).toLowerCase() : '';
  if (role && role !== 'assistant') {
    return null;
  }
  return cloneJson(message as JsonObject) as JsonObject;
}

function buildToolMessagesFromToolOutputs(chatResponse: JsonObject): JsonObject[] {
  const outputs = Array.isArray((chatResponse as any).tool_outputs) ? ((chatResponse as any).tool_outputs as any[]) : [];
  const out: JsonObject[] = [];
  for (const entry of outputs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const toolCallId = typeof (entry as any).tool_call_id === 'string' ? String((entry as any).tool_call_id) : '';
    if (!toolCallId) continue;
    const name = typeof (entry as any).name === 'string' && String((entry as any).name).trim()
      ? String((entry as any).name).trim()
      : 'tool';
    const rawContent = (entry as any).content;
    let contentText: string;
    if (typeof rawContent === 'string') {
      contentText = rawContent;
    } else {
      try {
        contentText = JSON.stringify(rawContent ?? {});
      } catch {
        contentText = String(rawContent ?? '');
      }
    }
    out.push({ role: 'tool', tool_call_id: toolCallId, name, content: contentText } as JsonObject);
  }
  return out;
}

function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function injectClockToolOutput(base: JsonObject, toolCall: ToolCall, content: unknown): JsonObject {
  const cloned = cloneJson(base);
  const existingOutputs = Array.isArray((cloned as any).tool_outputs)
    ? ((cloned as any).tool_outputs as JsonValue[])
    : [];
  let payloadText: string;
  if (typeof content === 'string') {
    payloadText = content;
  } else {
    try {
      payloadText = JSON.stringify(content ?? {});
    } catch {
      payloadText = String(content ?? '');
    }
  }
  (cloned as any).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: 'clock',
      content: payloadText
    }
  ];
  return cloned;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stripClockStopMarkerFromText(raw: string): { updated: string; changed: boolean } {
  const lines = String(raw || '').split(/\r?\n/);
  let changed = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*Clock-Stop-When:\s*.+$/i.test(line)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  return { updated: kept.join('\n'), changed };
}

async function clearClockStopMarkerForReactivation(adapterContext: Record<string, unknown>): Promise<void> {
  const workdir = resolveWorkingDirectoryFromAdapterContextOrFallback(adapterContext);
  if (!workdir) {
    return;
  }
  const clockMdPath = path.join(workdir, 'clock.md');
  let raw = '';
  try {
    raw = await fs.readFile(clockMdPath, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const stripped = stripClockStopMarkerFromText(raw);
  if (!stripped.changed) {
    return;
  }
  await fs.writeFile(clockMdPath, stripped.updated, 'utf8');
}

function normalizeAction(value: unknown): 'get' | 'schedule' | 'update' | 'list' | 'cancel' | 'clear' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'get' || raw === 'list' || raw === 'cancel' || raw === 'clear' || raw === 'schedule' || raw === 'update') {
    return raw;
  }
  return 'schedule';
}

function toIso(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function parseRecurrenceKind(raw: unknown): 'daily' | 'weekly' | 'interval' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) {
    return undefined;
  }
  if (value === 'daily' || value === 'day') {
    return 'daily';
  }
  if (value === 'weekly' || value === 'week') {
    return 'weekly';
  }
  if (value === 'interval' || value === 'every_minutes' || value === 'every-minutes' || value === 'everyminutes') {
    return 'interval';
  }
  return undefined;
}

function parseRecurrenceFromRecord(record: Record<string, unknown>): { recurrence?: ClockTaskRecurrence; message?: string } {
  const recurrenceRaw = record.recurrence ?? record.repeat ?? record.cycle;
  const maxRunsRaw = Number(record.maxRuns ?? (recurrenceRaw && typeof recurrenceRaw === 'object' && !Array.isArray(recurrenceRaw)
    ? (recurrenceRaw as Record<string, unknown>).maxRuns
    : undefined));

  if (recurrenceRaw === undefined || recurrenceRaw === null || recurrenceRaw === false) {
    return {};
  }

  let kind: 'daily' | 'weekly' | 'interval' | undefined;
  let everyMinutesRaw: unknown;

  if (typeof recurrenceRaw === 'string') {
    kind = parseRecurrenceKind(recurrenceRaw);
    everyMinutesRaw = record.everyMinutes;
  } else if (recurrenceRaw && typeof recurrenceRaw === 'object' && !Array.isArray(recurrenceRaw)) {
    const recurrenceRecord = recurrenceRaw as Record<string, unknown>;
    kind = parseRecurrenceKind(recurrenceRecord.kind ?? recurrenceRecord.type ?? recurrenceRecord.mode ?? recurrenceRecord.every);
    everyMinutesRaw = recurrenceRecord.everyMinutes ?? recurrenceRecord.minutes ?? record.everyMinutes;
  }

  if (!kind) {
    return { message: 'clock.schedule recurrence kind must be daily|weekly|interval' };
  }

  const maxRuns = Number.isFinite(maxRunsRaw) ? Math.floor(maxRunsRaw) : NaN;
  if (!Number.isFinite(maxRuns) || maxRuns <= 0) {
    return { message: 'clock.schedule recurring task requires maxRuns >= 1' };
  }

  if (kind === 'interval') {
    const everyMinutesNum = Number(everyMinutesRaw);
    const everyMinutes = Number.isFinite(everyMinutesNum) ? Math.floor(everyMinutesNum) : NaN;
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      return { message: 'clock.schedule interval recurrence requires everyMinutes >= 1' };
    }
    return { recurrence: { kind: 'interval', maxRuns, everyMinutes } };
  }

  return { recurrence: { kind, maxRuns } };
}

function normalizeScheduleItems(parsed: Record<string, unknown>): {
  ok: boolean;
  items: ClockScheduleItem[];
  message?: string;
} {
  const itemsRaw = parsed.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    return { ok: false, items: [], message: 'clock.schedule requires items: [{ dueAt, task, tool?, arguments? }]' };
  }
  const items: ClockScheduleItem[] = [];
  for (const entry of itemsRaw) {
    const rec = asPlainObject(entry);
    if (!rec) {
      return { ok: false, items: [], message: 'clock.schedule items must be objects' };
    }
    const dueAtMs = parseDueAtMs(rec.dueAt);
    if (!dueAtMs) {
      return { ok: false, items: [], message: 'clock.schedule dueAt must be an ISO8601 string' };
    }
    const task = typeof rec.task === 'string' ? rec.task.trim() : '';
    if (!task) {
      return { ok: false, items: [], message: 'clock.schedule task must be a non-empty string' };
    }
    const tool = typeof rec.tool === 'string' && rec.tool.trim().length ? rec.tool.trim() : undefined;
    const argsObj = (() => {
      const raw = rec.arguments;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return cloneJson(raw as Record<string, unknown>) as Record<string, unknown>;
      }
      if (typeof raw === 'string' && raw.trim().length) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    })();
    const recurrenceParsed = parseRecurrenceFromRecord(rec);
    if (recurrenceParsed.message) {
      return { ok: false, items: [], message: recurrenceParsed.message };
    }
    items.push({
      dueAtMs,
      task,
      setBy: 'agent',
      ...(tool ? { tool } : {}),
      ...(argsObj ? { arguments: argsObj } : {}),
      ...(recurrenceParsed.recurrence ? { recurrence: recurrenceParsed.recurrence } : {})
    });
  }
  return { ok: true, items };
}

function mapTaskForTool(t: ClockTask): Record<string, unknown> {
  const recurrence = t.recurrence && typeof t.recurrence === 'object'
    ? {
      kind: t.recurrence.kind,
      maxRuns: t.recurrence.maxRuns,
      ...(t.recurrence.kind === 'interval' && typeof t.recurrence.everyMinutes === 'number'
        ? { everyMinutes: t.recurrence.everyMinutes }
        : {})
    }
    : undefined;
  const remainingRuns = recurrence
    ? Math.max(0, Math.floor(Number(recurrence.maxRuns) || 0) - Math.max(0, Math.floor(Number(t.deliveryCount) || 0)))
    : undefined;
  return {
    taskId: t.taskId,
    dueAt: toIso(t.dueAtMs),
    setBy: t.setBy === 'agent' ? 'agent' : 'user',
    setAt: toIso(t.createdAtMs),
    task: t.task,
    ...(t.tool ? { tool: t.tool } : {}),
    ...(t.arguments ? { arguments: t.arguments } : {}),
    ...(typeof t.deliveredAtMs === 'number' ? { deliveredAt: toIso(t.deliveredAtMs) } : {}),
    deliveryCount: t.deliveryCount,
    ...(recurrence ? { recurrence } : {}),
    ...(typeof remainingRuns === 'number' ? { remainingRuns } : {})
  };
}

function buildNearbyReminderWarnings(scheduled: ClockTask[], allTasks: ClockTask[]): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const task of scheduled) {
    const nearby = findNearbyClockTasks(allTasks, task, CLOCK_NEARBY_REMINDER_WINDOW_MS);
    if (!nearby.length) {
      continue;
    }
    const nearbyIds = nearby.map((item) => item.taskId).sort().join(',');
    const dedupeKey = `${task.taskId}:${nearbyIds}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    warnings.push({
      scheduled: mapTaskForTool(task),
      nearby: nearby.map(mapTaskForTool),
      message:
        'Another reminder is within 5 minutes of this one. Consider using clock.update to merge or retime existing reminders instead of keeping two very close alarms.'
    });
  }
  return warnings;
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ensureClockToolCall(ctx.toolCall, ctx.requestId);
  if (!toolCall) {
    return null;
  }

  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const sessionId = resolveClockSessionScope(
    ctx.adapterContext as unknown as Record<string, unknown>,
    rt as unknown as Record<string, unknown>
  );
  const rawConfig = (rt as any)?.clock ?? (ctx.adapterContext as any).clock;
  // Default-enable clock when config is absent, but keep "explicitly disabled" honored.
  const clockConfig = resolveClockConfig(rawConfig);
  const parsedArgs = parseToolArguments(toolCall);
  const action = normalizeAction(parsedArgs.action);

  const respond = (payload: Record<string, unknown>): ServerToolHandlerPlan => {
    return {
      flowId: FLOW_ID,
      finalize: async () => {
        const patched = injectClockToolOutput(ctx.base, toolCall, payload);
        const seed = extractCapturedChatSeed((ctx.adapterContext as any)?.capturedChatRequest);
        const canFollowup = Boolean(seed);
        const bootstrapActive = (rt as any)?.antigravityThoughtSignatureBootstrap === true;
        const forcedProviderKey =
          bootstrapActive &&
          typeof (ctx.adapterContext as any).providerKey === 'string' &&
          String((ctx.adapterContext as any).providerKey).trim()
            ? String((ctx.adapterContext as any).providerKey).trim()
            : '';
        return {
          chatResponse: patched,
          execution: {
            flowId: FLOW_ID,
            ...(canFollowup
              ? {
                followup: {
                  requestIdSuffix: ':clock_followup',
                  entryEndpoint: ctx.entryEndpoint,
                  ...(bootstrapActive && seed
                    ? {
                      payload: (() => {
                        const messages = Array.isArray(seed.messages) ? (cloneJson(seed.messages) as JsonObject[]) : [];
                        const assistant = extractAssistantMessageFromChatLike(ctx.base);
                        if (assistant) {
                          messages.push(assistant);
                        }
                        messages.push(...buildToolMessagesFromToolOutputs(patched));
                        const params: Record<string, unknown> =
                          seed.parameters && typeof seed.parameters === 'object' && !Array.isArray(seed.parameters)
                            ? { ...(seed.parameters as Record<string, unknown>) }
                            : {};
                        // Bootstrap-only: the first hop forces tool_config=clock; the second hop must clear it
                        // so the model can either answer or call other tools normally.
                        delete (params as any).tool_config;
                        return {
                          ...(seed.model ? { model: seed.model } : {}),
                          messages,
                          ...(Array.isArray(seed.tools) ? { tools: cloneJson(seed.tools) as JsonObject[] } : {}),
                          ...(Object.keys(params).length ? { parameters: params } : {})
                        } as JsonObject;
                      })(),
                      metadata: (() => {
                        const meta: JsonObject = {};
                        if (forcedProviderKey) {
                          (meta as any).__shadowCompareForcedProviderKey = forcedProviderKey;
                        }
                        const runtime = ensureRuntimeMetadata(meta as unknown as Record<string, unknown>);
                        (runtime as any).antigravityThoughtSignatureBootstrapAttempted = true;
                        return meta;
                      })()
                    }
                    : {
                      injection: {
                        ops: [
                          { op: 'append_assistant_message', required: true },
                          { op: 'append_tool_messages_from_tool_outputs', required: true }
                        ]
                      }
                    })
                }
              }
              : {})
          }
        };
      }
    };
  };

  if (!clockConfig) {
    logClock('disabled', { action, hasSessionId: true });
    return respond({
      ok: false,
      action,
      message: 'clock tool is not enabled (virtualrouter.clock.enabled=true required).'
    });
  }
  await startClockDaemonIfNeeded(clockConfig);

  if (action === 'get') {
    try {
      const snapshot = await getClockTimeSnapshot();
      logClock('get', { hasSessionId: Boolean(sessionId) });
      return respond({
        ok: true,
        action,
        active: true,
        nowMs: snapshot.nowMs,
        utc: snapshot.utc,
        local: snapshot.local,
        timezone: snapshot.timezone,
        ntp: snapshot.ntp
      });
    } catch (err) {
      logClock('get_error', { message: String((err as any)?.message || err || '') });
      return respond({
        ok: false,
        action,
        message: `clock.get failed: ${String((err as any)?.message || err || 'unknown')}`
      });
    }
  }

  if (!sessionId) {
    logClock('missing_session', { action });
    return respond({
      ok: false,
      action,
      message: 'clock requires tmux session scope (clientTmuxSessionId/tmuxSessionId).'
    });
  }

  if (action === 'list') {
    const listedState = await markClockListObserved(sessionId, clockConfig);
    const items = listedState.tasks.slice();
    logClock('list', { sessionId, count: items.length });
    return respond({
      ok: true,
      action,
      items: items.map(mapTaskForTool),
      guidance: 'Review existing reminders first. Prefer clock.update for edits; create a new reminder only when no existing one fits.'
    });
  }

  if (action === 'clear') {
    const removedCount = await clearClockTasks(sessionId, clockConfig);
    logClock('clear', { sessionId, removedCount });
    return respond({ ok: true, action, removedCount });
  }

  if (action === 'cancel') {
    const taskId = typeof parsedArgs.taskId === 'string' ? parsedArgs.taskId.trim() : '';
    if (!taskId) {
      logClock('cancel_invalid', { sessionId, action });
      return respond({ ok: false, action, message: 'clock.cancel requires taskId' });
    }
    const removed = await cancelClockTask(sessionId, taskId, clockConfig);
    logClock('cancel', { sessionId, taskId, removed });
    return respond({ ok: true, action, removed: removed ? taskId : null });
  }

  if (action === 'update') {
    const taskId = typeof parsedArgs.taskId === 'string' ? parsedArgs.taskId.trim() : '';
    if (!taskId) {
      logClock('update_invalid', { sessionId, action, reason: 'missing_task_id' });
      return respond({ ok: false, action, message: 'clock.update requires taskId' });
    }
    const normalized = normalizeScheduleItems(parsedArgs);
    if (!normalized.ok || normalized.items.length < 1) {
      logClock('update_invalid', { sessionId, action, message: normalized.message ?? 'invalid update payload' });
      return respond({ ok: false, action, message: normalized.message ?? 'clock.update requires items[0] with dueAt/task' });
    }
    const item = normalized.items[0];
    const patch: ClockTaskUpdatePatch = {
      dueAtMs: item.dueAtMs,
      task: item.task,
      resetDelivery: true,
      ...(item.tool ? { tool: item.tool } : {}),
      ...(item.arguments ? { arguments: item.arguments } : {}),
      ...(item.recurrence ? { recurrence: item.recurrence } : {})
    };
    const updated = await updateClockTask(sessionId, taskId, patch, clockConfig);
    if (!updated) {
      logClock('update_miss', { sessionId, taskId });
      return respond({ ok: false, action, message: 'clock.update failed: task not found or patch invalid' });
    }
    await clearClockStopMarkerForReactivation(ctx.adapterContext as unknown as Record<string, unknown>).catch(() => {});
    logClock('update', { sessionId, taskId });
    return respond({ ok: true, action, updated: mapTaskForTool(updated) });
  }

  const normalized = normalizeScheduleItems(parsedArgs);
  if (!normalized.ok) {
    logClock('schedule_invalid', { sessionId, message: normalized.message ?? 'invalid schedule items' });
    return respond({ ok: false, action, message: normalized.message ?? 'invalid schedule items' });
  }
  const stateBeforeSchedule = await loadClockSessionState(sessionId, clockConfig);
  if (!hasObservedClockList(stateBeforeSchedule)) {
    logClock('schedule_blocked_missing_list', { sessionId, count: normalized.items.length });
    return respond({
      ok: false,
      action,
      message: CLOCK_LIST_REQUIRED_MESSAGE,
      requiredAction: 'list',
      suggestion: 'Run clock.list now, inspect current reminders, then use clock.update when possible before falling back to clock.schedule.'
    });
  }
  const at = nowMs();
  const guardedItems: ClockScheduleItem[] = normalized.items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (!Number.isFinite(item.dueAtMs)) return item;
    // When dueAt is already within the trigger window, do NOT allow same-request injection.
    if (item.dueAtMs <= at + clockConfig.dueWindowMs) {
      return { ...item, notBeforeRequestId: ctx.requestId };
    }
    return item;
  });
  const scheduled = await scheduleClockTasks(sessionId, guardedItems, clockConfig);
  await clearClockStopMarkerForReactivation(ctx.adapterContext as unknown as Record<string, unknown>).catch(() => {});
  logClock('schedule', { sessionId, count: scheduled.length });
  const allTasks = await listClockTasks(sessionId, clockConfig);
  const nearbyWarnings = buildNearbyReminderWarnings(scheduled, allTasks);
  return respond({
    ok: true,
    action,
    scheduled: scheduled.map(mapTaskForTool),
    ...(nearbyWarnings.length
      ? {
        warning:
          'Some reminders are within 5 minutes of another reminder. Consider editing existing reminders instead of creating nearby duplicates.',
        nearbyReminders: nearbyWarnings
      }
      : {})
  });
};

registerServerToolHandler('clock', handler);
