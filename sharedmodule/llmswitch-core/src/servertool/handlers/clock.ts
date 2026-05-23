import fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
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
import { formatUnknownError } from '../../shared/common-utils.js';
import {
  extractAssistantMessageFromChatLike,
  buildToolMessagesFromToolOutputs,
  parseToolArguments,
  injectClockToolOutput,
  asPlainObject,
  stripClockStopMarkerFromText,
  parseRecurrenceFromRecord,
  normalizeScheduleItems,
  mapTaskForTool,
} from './clock-pure-blocks.js';

const FLOW_ID = 'clock_flow';
const CLOCK_LIST_REQUIRED_MESSAGE =
  'clock.schedule requires clock.list immediately before creating a new reminder. List existing reminders first, and prefer clock.update when you can edit an existing reminder instead of creating another one.';
const CLOCK_NEARBY_REMINDER_WINDOW_MS = 5 * 60_000;
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
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== 'clock') {
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
        return {
          chatResponse: patched,
          execution: {
            flowId: FLOW_ID,
            ...(canFollowup
              ? {
                followup: {
                  requestIdSuffix: ':clock_followup',
                  entryEndpoint: ctx.entryEndpoint,
                  injection: {
                    ops: [
                      { op: 'append_assistant_message', required: true },
                      { op: 'append_tool_messages_from_tool_outputs', required: true }
                    ]
                  }
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
    await clearClockStopMarkerForReactivation(ctx.adapterContext as unknown as Record<string, unknown>).catch((error) => {
      logClock('reactivate_clear_stop_marker_failed', {
        sessionId,
        action: 'update',
        message: formatUnknownError(error)
      });
    });
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
  const toolCallOwnedItems: ClockScheduleItem[] = normalized.items.map((item) => ({
    ...item,
    setBy: item.setBy ?? 'agent'
  }));
  const guardedItems: ClockScheduleItem[] = toolCallOwnedItems.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (!Number.isFinite(item.dueAtMs)) return item;
    // When dueAt is already within the trigger window, do NOT allow same-request injection.
    if (item.dueAtMs <= at + clockConfig.dueWindowMs) {
      return { ...item, notBeforeRequestId: ctx.requestId };
    }
    return item;
  });
  const scheduled = await scheduleClockTasks(sessionId, guardedItems, clockConfig);
  await clearClockStopMarkerForReactivation(ctx.adapterContext as unknown as Record<string, unknown>).catch((error) => {
    logClock('reactivate_clear_stop_marker_failed', {
      sessionId,
      action: 'schedule',
      message: formatUnknownError(error)
    });
  });
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
