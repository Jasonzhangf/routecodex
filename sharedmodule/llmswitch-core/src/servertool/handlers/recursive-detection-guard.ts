import { createHash } from 'node:crypto';
import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  ServerToolFollowupInjectionOp,
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan,
  ToolCall
} from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';

const FLOW_ID = 'recursive_detection_guard';
const CONSECUTIVE_TRIGGER_COUNT = 10;

type RecursiveDetectionConfig = {
  enabled: boolean;
  ttlMs: number;
  maxSessions: number;
};

type SessionLoopState = {
  updatedAt: number;
  signature?: string;
  consecutiveCount: number;
  triggerCount: number;
};

const sessionStates = new Map<string, SessionLoopState>();

const DEBUG_RECURSIVE_DETECTION =
  String(process.env.ROUTECODEX_RECURSIVE_DETECTION_DEBUG || '').trim() === '1';

function debugLog(message: string, extra?: Record<string, unknown>): void {
  if (!DEBUG_RECURSIVE_DETECTION) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`[recursive-detection][debug] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
  } catch {
    /* ignore logging failures */
  }
}

function getRecursiveDetectionConfig(): RecursiveDetectionConfig {
  const enabled = String(process.env.ROUTECODEX_RECURSIVE_DETECTION_ENABLED ?? '').trim().toLowerCase() !== 'false';
  return {
    enabled,
    ttlMs: 5 * 60 * 1000,
    maxSessions: 2000
  };
}

function shouldSkipFollowup(adapterContext: unknown): boolean {
  const record = adapterContext as Record<string, unknown> | null;
  const rt = readRuntimeMetadata(record ?? undefined);
  const loopState = rt ? (rt as any).serverToolLoopState : undefined;
  if (loopState && typeof loopState === 'object' && !Array.isArray(loopState)) {
    return true;
  }
  const raw = rt ? (rt as any).serverToolFollowup : undefined;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }
  return false;
}

function resolveSessionKey(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return 'default';
  }
  const record = adapterContext as Record<string, unknown>;
  const sessionId =
    typeof record.sessionId === 'string'
      ? record.sessionId.trim()
      : (typeof record.session_id === 'string' ? record.session_id.trim() : '');
  const conversationId =
    typeof record.conversationId === 'string'
      ? record.conversationId.trim()
      : (typeof record.conversation_id === 'string' ? record.conversation_id.trim() : '');
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : '';
  if (sessionId) {
    return `session:${sessionId}`;
  }
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  if (requestId) {
    return `request:${requestId}`;
  }
  return 'default';
}

function normalizeToolName(name: string): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function sha256(value: string): string {
  try {
    return createHash('sha256').update(value).digest('hex');
  } catch {
    return '';
  }
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (t === 'boolean') return (value as boolean) ? 'true' : 'false';
  if (t === 'bigint') return JSON.stringify(String(value));
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return 'null';
  }
}

function normalizeToolArgs(toolCall: ToolCall): string {
  const raw = typeof toolCall.arguments === 'string' ? toolCall.arguments : '';
  if (!raw || !raw.trim()) return '{}';
  try {
    const parsed = JSON.parse(raw);
    return stableStringify(parsed);
  } catch {
    return raw.trim();
  }
}

function buildCallSignature(toolCall: ToolCall): string {
  const toolName = normalizeToolName(toolCall.name);
  const args = normalizeToolArgs(toolCall);
  return sha256(`${toolName}\n${args}`);
}

function cleanupSessions(now: number, config: RecursiveDetectionConfig): void {
  const cutoff = now - config.ttlMs;
  if (sessionStates.size > config.maxSessions) {
    for (const [key, state] of sessionStates.entries()) {
      if (!state || state.updatedAt <= cutoff) {
        sessionStates.delete(key);
      }
    }
    return;
  }
  for (const [key, state] of sessionStates.entries()) {
    if (!state || state.updatedAt <= cutoff) {
      sessionStates.delete(key);
    }
  }
}

function injectBlockedToolResult(base: JsonObject, toolCall: ToolCall, options: { signature: string }): JsonObject {
  const cloned = cloneJson(base);
  const existingOutputs = Array.isArray((cloned as { tool_outputs?: unknown }).tool_outputs)
    ? ((cloned as { tool_outputs: unknown[] }).tool_outputs as unknown[])
    : [];

  const payload = {
    ok: false,
    blocked: true,
    reason: 'RECURSIVE_TOOL_CALL_DETECTED',
    rule: {
      kind: 'consecutive_same_tool_and_args',
      consecutive: CONSECUTIVE_TRIGGER_COUNT
    },
    tool: toolCall.name,
    signature: options.signature
  };

  (cloned as Record<string, unknown>).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content: JSON.stringify(payload)
    }
  ];
  return cloned;
}

function buildSingleToolCallAssistantMessage(toolCall: ToolCall): JsonObject {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : ''
        }
      }
    ]
  } as JsonObject;
}

function buildToolMessages(chatResponse: JsonObject): JsonObject[] {
  const toolOutputs = Array.isArray((chatResponse as { tool_outputs?: unknown }).tool_outputs)
    ? ((chatResponse as { tool_outputs: unknown[] }).tool_outputs as unknown[])
    : [];
  const messages: JsonObject[] = [];
  for (const entry of toolOutputs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const toolCallId = typeof record.tool_call_id === 'string' ? record.tool_call_id : undefined;
    if (!toolCallId) continue;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'tool';
    const rawContent = record.content;
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
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name,
      content: contentText
    } as JsonObject);
  }
  return messages;
}

function hasAssistantMessageFromChatLike(chatResponse: JsonObject): boolean {
  if (!chatResponse || typeof chatResponse !== 'object') {
    return false;
  }
  const choices = Array.isArray((chatResponse as { choices?: unknown }).choices)
    ? ((chatResponse as { choices: unknown[] }).choices as unknown[])
    : [];
  if (!choices.length) {
    return false;
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return false;
  }
  const message = (first as { message?: unknown }).message;
  return Boolean(message && typeof message === 'object' && !Array.isArray(message));
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const config = getRecursiveDetectionConfig();
  if (!config.enabled) {
    return null;
  }

  const now = Date.now();
  cleanupSessions(now, config);

  const sessionKey = resolveSessionKey(ctx.adapterContext);
  // Treat followup hops as an interruption: do not count them, and clear any ongoing streak
  // so that post-followup calls always restart from 0.
  if (shouldSkipFollowup(ctx.adapterContext)) {
    const prev = sessionStates.get(sessionKey);
    if (prev) {
      sessionStates.set(sessionKey, {
        ...prev,
        updatedAt: now,
        signature: undefined,
        consecutiveCount: 0
      });
    }
    return null;
  }
  const existing = sessionStates.get(sessionKey) ?? { updatedAt: now, consecutiveCount: 0, triggerCount: 0 };

  // Any interruption (no tool calls) resets the counter.
  if (!ctx.toolCalls || !ctx.toolCalls.length) {
    if (existing.signature || existing.consecutiveCount || existing.triggerCount) {
      if (existing.triggerCount > 0) {
        sessionStates.set(sessionKey, {
          ...existing,
          updatedAt: now,
          signature: undefined,
          consecutiveCount: 0
        });
      } else {
        sessionStates.delete(sessionKey);
      }
    } else {
      sessionStates.delete(sessionKey);
    }
    return null;
  }

  let state: SessionLoopState = { ...existing, updatedAt: now };
  for (const toolCall of ctx.toolCalls) {
    const signature = buildCallSignature(toolCall);
    if (state.signature && state.signature === signature) {
      state.consecutiveCount += 1;
    } else {
      state.signature = signature;
      state.consecutiveCount = 1;
    }
    state.updatedAt = now;

    debugLog('observe', {
      sessionKey,
      toolName: toolCall.name,
      consecutiveCount: state.consecutiveCount
    });

    if (state.consecutiveCount < CONSECUTIVE_TRIGGER_COUNT) {
      continue;
    }

    const triggerCount = (state.triggerCount || 0) + 1;
    const escalatedStop = triggerCount >= 2;
    // Triggered: clear streak immediately; escalate on second trigger.
    // After escalated stop, clear state so next execution starts fresh.
    if (escalatedStop) {
      sessionStates.delete(sessionKey);
    } else {
      sessionStates.set(sessionKey, {
        updatedAt: now,
        signature: undefined,
        consecutiveCount: 0,
        triggerCount
      });
    }

    // Must send a followup request to provider (not a direct client warning).
    if (!ctx.capabilities.reenterPipeline) {
      return null;
    }

    const patched = injectBlockedToolResult(ctx.base, toolCall, { signature });

    // Fail-closed: if we cannot build a followup request, do not intercept.
    const captured =
      ctx.adapterContext && typeof ctx.adapterContext === 'object'
        ? ((ctx.adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest as unknown)
        : undefined;
    const seed = extractCapturedChatSeed(captured);
    if (!seed) {
      return null;
    }
    if (!hasAssistantMessageFromChatLike(patched)) {
      return null;
    }
    const toolMessages = buildToolMessages(patched);
    if (!toolMessages.length) {
      return null;
    }

    const reminder = escalatedStop
      ? `再次检测到同一循环（同一工具同一参数连续 ${CONSECUTIVE_TRIGGER_COUNT} 次：${toolCall.name}）。` +
        `现在停止该工具链路并直接报告阻塞点，等待用户处理后再继续。`
      : `检测到循环调用（同一工具同一参数连续 ${CONSECUTIVE_TRIGGER_COUNT} 次：${toolCall.name}）。` +
        `请先简短提醒风险并清理当前循环计数，然后继续自动执行；若再次出现同样循环，立即停止并报告阻塞。`;

    const ops: ServerToolFollowupInjectionOp[] = [
      { op: 'inject_system_text', text: reminder },
      { op: 'append_assistant_message' },
      { op: 'append_tool_messages_from_tool_outputs' }
    ];
    if (escalatedStop) {
      ops.push({ op: 'drop_tool_by_name', name: toolCall.name });
    }

    return {
      flowId: FLOW_ID,
      finalize: async () => ({
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':recursive_detection_guard_followup',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops
            }
          }
        }
      })
    };
  }

  sessionStates.set(sessionKey, state);
  return null;
};

registerServerToolHandler('recursive_detection_guard', handler, { trigger: 'auto', hook: { phase: 'pre', priority: 5 } });
