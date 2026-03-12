import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerToolBackendPlan,
  ServerToolBackendResult,
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ServerToolHandlerResult,
  ServerToolExecution,
  ToolCall,
  ServerToolHandlerPlan,
  ServerToolAutoHookTraceEvent
} from './types.js';
import { getServerToolHandler, listAutoServerToolHooks } from './registry.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { executeWebSearchBackendPlan } from './handlers/web-search.js';
import { executeVisionBackendPlan } from './handlers/vision.js';
import './handlers/iflow-model-error-retry.js';
import './handlers/antigravity-thought-signature-bootstrap.js';
import './handlers/stop-message-auto.js';
import './handlers/clock.js';
import './handlers/clock-auto.js';
import './handlers/exec-command-guard.js';
import './handlers/apply-patch-guard.js';
import './handlers/continue-execution.js';
import './handlers/review.js';
import { runPreCommandHooks } from './pre-command-hooks.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync } from '../router/virtual-router/sticky-session-store.js';

function traceAutoHook(
  options: ServerSideToolEngineOptions,
  event: ServerToolAutoHookTraceEvent
): void {
  try {
    options.onAutoHookTrace?.(event);
  } catch {
    // best-effort trace callback
  }
}

type AutoHookQueueName = 'A_optional' | 'B_mandatory';
type AutoHookDescriptor = ReturnType<typeof listAutoServerToolHooks>[number];

const OPTIONAL_PRIMARY_HOOK_ORDER = ['clock_auto', 'stop_message_auto'] as const;
const MANDATORY_HOOK_ORDER: readonly string[] = [];

let fallbackToolCallIdSeq = 0;

function ensureToolCallId(record: Record<string, unknown> | JsonObject): string {
  const existing = typeof (record as any).id === 'string' ? String((record as any).id).trim() : '';
  if (existing) {
    return existing;
  }
  fallbackToolCallIdSeq += 1;
  const generated = `call_servertool_fallback_${Date.now()}_${fallbackToolCallIdSeq}`;
  (record as any).id = generated;
  return generated;
}

function buildAutoHookQueues(hooks: AutoHookDescriptor[]): {
  optionalQueue: AutoHookDescriptor[];
  mandatoryQueue: AutoHookDescriptor[];
} {
  const hookById = new Map<string, AutoHookDescriptor>();
  for (const hook of hooks) {
    if (!hook || typeof hook.id !== 'string') {
      continue;
    }
    hookById.set(hook.id, hook);
  }

  const consumed = new Set<string>();
  const optionalQueue: AutoHookDescriptor[] = [];

  for (const hook of hooks) {
    if (hook.phase !== 'pre') {
      continue;
    }
    if (consumed.has(hook.id)) {
      continue;
    }
    optionalQueue.push(hook);
    consumed.add(hook.id);
  }

  for (const id of OPTIONAL_PRIMARY_HOOK_ORDER) {
    const hook = hookById.get(id);
    if (!hook || consumed.has(hook.id)) {
      continue;
    }
    optionalQueue.push(hook);
    consumed.add(hook.id);
  }

  for (const hook of hooks) {
    if (consumed.has(hook.id)) {
      continue;
    }
    optionalQueue.push(hook);
    consumed.add(hook.id);
  }

  const mandatoryQueue: AutoHookDescriptor[] = [];
  const mandatorySeen = new Set<string>();
  for (const id of MANDATORY_HOOK_ORDER) {
    const hook = hookById.get(id);
    if (!hook || mandatorySeen.has(hook.id)) {
      continue;
    }
    mandatoryQueue.push(hook);
    mandatorySeen.add(hook.id);
  }

  return { optionalQueue, mandatoryQueue };
}

// Extract tool calls from messages array (for Responses API and tool_governance stage)
function extractToolCallsFromMessagesArray(chatResponse: JsonObject): ToolCall[] {
  const messages = getArray((chatResponse as any).messages);
  const calls: ToolCall[] = [];
  for (const msg of messages) {
    const msgObj = asObject(msg);
    if (!msgObj) continue;
    const role = (msgObj as any).role;
    if (role !== 'assistant') continue;
    const toolCalls = getArray((msgObj as any).tool_calls);
    for (const raw of toolCalls) {
      const tc = asObject(raw);
      if (!tc) continue;
      const id = ensureToolCallId(tc as Record<string, unknown>);
      const fn =
        asObject((tc as Record<string, unknown>).function) ??
        asObject((tc as Record<string, unknown>).functionCall) ??
        asObject((tc as Record<string, unknown>).function_call);
      const name = fn && typeof fn.name === 'string' && fn.name.trim() ? fn.name.trim() : '';
      const rawArgs =
        (fn ? (fn as Record<string, unknown>).arguments : undefined) ??
        (fn ? (fn as Record<string, unknown>).args : undefined) ??
        (fn ? (fn as Record<string, unknown>).input : undefined) ??
        (tc as Record<string, unknown>).arguments ??
        (tc as Record<string, unknown>).args ??
        (tc as Record<string, unknown>).input;
      let args = '';
      if (typeof rawArgs === 'string') {
        args = rawArgs;
      } else if (rawArgs && typeof rawArgs === 'object') {
        try {
          args = JSON.stringify(rawArgs);
        } catch {
          args = '';
        }
      } else if (rawArgs !== undefined && rawArgs !== null) {
        args = String(rawArgs);
      }
      calls.push({ id, name, arguments: args });
    }
  }
  return calls;
}

function normalizeFilterTokenSet(values: string[] | undefined): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim().toLowerCase();
    if (!value) {
      continue;
    }
    normalized.add(value);
  }
  return normalized.size > 0 ? normalized : null;
}

function isNameIncluded(
  name: string,
  includeSet: Set<string> | null,
  excludeSet: Set<string> | null
): boolean {
  const normalized = normalizeServerToolCallName(name);
  if (includeSet && !includeSet.has(normalized)) {
    return false;
  }
  if (excludeSet && excludeSet.has(normalized)) {
    return false;
  }
  return true;
}

function normalizeServerToolCallName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'websearch' || normalized === 'web-search') {
    return 'web_search';
  }
  return normalized;
}

function readText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveStickyKeyFromAdapterContext(record: Record<string, unknown>): string | undefined {
  const runtime = readRuntimeMetadata(record) as Record<string, unknown> | undefined;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const explicitScope =
    readText(runtime?.stopMessageClientInjectSessionScope) ||
    readText(runtime?.stopMessageClientInjectScope) ||
    readText(record.stopMessageClientInjectSessionScope) ||
    readText(record.stopMessageClientInjectScope);
  if (
    explicitScope &&
    (explicitScope.startsWith('tmux:') ||
      explicitScope.startsWith('session:') ||
      explicitScope.startsWith('conversation:'))
  ) {
    return explicitScope;
  }
  const tmuxSessionId =
    readText(record.clientTmuxSessionId) ||
    readText(record.client_tmux_session_id) ||
    readText(record.tmuxSessionId) ||
    readText(record.tmux_session_id) ||
    readText(runtime?.clientTmuxSessionId) ||
    readText(runtime?.client_tmux_session_id) ||
    readText(runtime?.tmuxSessionId) ||
    readText(runtime?.tmux_session_id) ||
    readText(metadata?.clientTmuxSessionId) ||
    readText(metadata?.client_tmux_session_id) ||
    readText(metadata?.tmuxSessionId) ||
    readText(metadata?.tmux_session_id);
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  const sessionId =
    readText(record.sessionId) ||
    readText((record as Record<string, unknown>).session_id) ||
    readText(runtime?.sessionId) ||
    readText(runtime?.session_id) ||
    readText(metadata?.sessionId) ||
    readText(metadata?.session_id);
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const conversationId =
    readText(record.conversationId) ||
    readText((record as Record<string, unknown>).conversation_id) ||
    readText(runtime?.conversationId) ||
    readText(runtime?.conversation_id) ||
    readText(metadata?.conversationId) ||
    readText(metadata?.conversation_id);
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  return undefined;
}

function extractToolCallsFromMessage(message: JsonObject): { raw: JsonObject; parsed: ToolCall }[] {
  const toolCalls = getArray((message as any).tool_calls);
  const out: { raw: JsonObject; parsed: ToolCall }[] = [];
  for (const raw of toolCalls) {
    const tc = asObject(raw);
    if (!tc) continue;
    const id = ensureToolCallId(tc as Record<string, unknown>);
    const fn =
      asObject((tc as Record<string, unknown>).function) ??
      asObject((tc as Record<string, unknown>).functionCall) ??
      asObject((tc as Record<string, unknown>).function_call);
    const name = fn && typeof (fn as any).name === 'string' && String((fn as any).name).trim()
      ? normalizeServerToolCallName(String((fn as any).name))
      : '';
    const rawArgs =
      (fn ? (fn as any).arguments : undefined) ??
      (fn ? (fn as any).args : undefined) ??
      (fn ? (fn as any).input : undefined) ??
      (tc as any).arguments ??
      (tc as any).args ??
      (tc as any).input;
    let args = '';
    if (typeof rawArgs === 'string') {
      args = rawArgs;
    } else if (rawArgs && typeof rawArgs === 'object') {
      try {
        args = JSON.stringify(rawArgs);
      } catch {
        args = '';
      }
    } else if (rawArgs !== undefined && rawArgs !== null) {
      args = String(rawArgs);
    }
    if (!name) continue;
    out.push({ raw: tc as JsonObject, parsed: { id, name, arguments: args } });
  }
  return out;
}

function buildAssistantToolCallMessage(toolCalls: ToolCall[]): JsonObject {
  const calls = toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: tc.arguments
    }
  }));
  return { role: 'assistant', content: null, tool_calls: calls } as JsonObject;
}

function appendToolOutput(base: JsonObject, toolCallId: string, name: string, content: string): void {
  const outputs = Array.isArray((base as any).tool_outputs) ? ((base as any).tool_outputs as any[]) : [];
  outputs.push({ tool_call_id: toolCallId, name, content });
  (base as any).tool_outputs = outputs;
}

function buildToolMessagesFromOutputs(base: JsonObject, allowIds: Set<string>): JsonObject[] {
  const outputs = Array.isArray((base as any).tool_outputs) ? ((base as any).tool_outputs as any[]) : [];
  const out: JsonObject[] = [];
  for (const entry of outputs) {
    if (!entry || typeof entry !== 'object') continue;
    const toolCallId = typeof (entry as any).tool_call_id === 'string' ? String((entry as any).tool_call_id) : '';
    if (!toolCallId || !allowIds.has(toolCallId)) continue;
    const name = typeof (entry as any).name === 'string' && String((entry as any).name).trim()
      ? String((entry as any).name).trim()
      : 'tool';
    const content = typeof (entry as any).content === 'string' ? String((entry as any).content) : JSON.stringify((entry as any).content ?? {});
    out.push({ role: 'tool', tool_call_id: toolCallId, name, content } as JsonObject);
  }
  return out;
}

function stripToolOutputs(base: JsonObject): void {
  try {
    delete (base as any).tool_outputs;
  } catch {
    /* ignore */
  }
}

function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
  try {
    for (const key of Object.keys(target)) {
      delete (target as any)[key];
    }
    for (const [k, v] of Object.entries(next)) {
      (target as any)[k] = v;
    }
  } catch {
    // ignore
  }
}

function patchToolCallArgumentsById(chatResponse: JsonObject, toolCallId: string, argumentsText: string): void {
  if (!toolCallId || typeof argumentsText !== 'string') {
    return;
  }
  const choices = getArray((chatResponse as any).choices);
  for (const choice of choices) {
    const choiceObj = asObject(choice);
    if (!choiceObj) continue;
    const message = asObject((choiceObj as any).message);
    if (!message) continue;
    const toolCalls = getArray((message as any).tool_calls);
    for (const toolCall of toolCalls) {
      const record = asObject(toolCall);
      if (!record) continue;
      const id = typeof (record as any).id === 'string' ? String((record as any).id).trim() : '';
      if (!id || id !== toolCallId) {
        continue;
      }
      const fn = asObject((record as any).function);
      if (fn) {
        (fn as any).arguments = argumentsText;
      }
      const fnCamel = asObject((record as any).functionCall);
      if (fnCamel) {
        (fnCamel as any).arguments = argumentsText;
      }
      const fnSnake = asObject((record as any).function_call);
      if (fnSnake) {
        (fnSnake as any).arguments = argumentsText;
      }
      if (Object.prototype.hasOwnProperty.call(record as any, 'arguments')) {
        (record as any).arguments = argumentsText;
      }
    }
  }
}

function filterOutExecutedToolCalls(chatResponse: JsonObject, executedIds: Set<string>): void {
  const choices = getArray((chatResponse as any).choices);
  for (const choice of choices) {
    const choiceObj = asObject(choice);
    if (!choiceObj) continue;
    const message = asObject((choiceObj as any).message);
    if (!message) continue;
    const toolCalls = getArray((message as any).tool_calls);
    if (!toolCalls.length) continue;
    const next = toolCalls.filter((tc) => {
      if (!tc || typeof tc !== 'object' || Array.isArray(tc)) return true;
      const id = typeof (tc as any).id === 'string' ? String((tc as any).id).trim() : '';
      if (!id) return true;
      return !executedIds.has(id);
    });
    (message as any).tool_calls = next;
  }
}

export async function runServerSideToolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const base = asObject(options.chatResponse);
  if (!base) {
    return { mode: 'passthrough', finalChatResponse: options.chatResponse };
  }

  let toolCalls = extractToolCalls(base);

  // Fallback: Responses API and tool_governance stage use messages array instead of choices
  if (toolCalls.length === 0) {
    toolCalls = extractToolCallsFromMessagesArray(base);
  }
  if (isClientDisconnected(options.adapterContext) && toolCalls.length > 0) {
    // When client is already disconnected, skip executing explicit tool_call servertools.
    // Auto hooks (e.g. stop_message_auto) still need to run to keep session state consistent.
    return { mode: 'passthrough', finalChatResponse: base };
  }
  const contextBase: Omit<ServerToolHandlerContext, 'toolCall'> = {
    base,
    toolCalls,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol,
    capabilities: {
      reenterPipeline: typeof options.reenterPipeline === 'function',
      providerInvoker: typeof options.providerInvoker === 'function'
    }
  };
  const includeToolCallNames = normalizeFilterTokenSet(options.includeToolCallHandlerNames);
  const excludeToolCallNames = normalizeFilterTokenSet(options.excludeToolCallHandlerNames);
  const includeAutoHookIds = normalizeFilterTokenSet(options.includeAutoHookIds);
  const excludeAutoHookIds = normalizeFilterTokenSet(options.excludeAutoHookIds);

  // Tool-call servertools: execute all executable servertool calls first, then decide:
  // - if only servertools were present -> followup via reenter (existing behavior)
  // - if mixed (servertool + client tools) -> persist servertool results, return remaining tool_calls to client
  const executedToolCalls: ToolCall[] = [];
  const executedIds = new Set<string>();
  const baseForExecution = cloneJson(base) as JsonObject;
  const executedFlowIds: string[] = [];
  let lastExecution: ServerToolExecution | undefined;
  const attemptedToolCallsByMessage: { parsed: ToolCall; raw: JsonObject }[] = [];
  const runtimeMetadata = readRuntimeMetadata(options.adapterContext as unknown as Record<string, unknown>);
  const runtimePreCommandState = (() => {
    const stickyKey = resolveStickyKeyFromAdapterContext(
      options.adapterContext as unknown as Record<string, unknown>
    );
    if (!stickyKey) {
      return undefined;
    }
    try {
      return loadRoutingInstructionStateSync(stickyKey) ?? undefined;
    } catch {
      return undefined;
    }
  })();

  const choices = getArray((base as any).choices);
  for (const choice of choices) {
    const choiceObj = asObject(choice);
    if (!choiceObj) continue;
    const message = asObject((choiceObj as any).message);
    if (!message) continue;
    attemptedToolCallsByMessage.push(...extractToolCallsFromMessage(message));
  }

  if (options.disableToolCallHandlers !== true) {
    for (const { parsed: toolCall } of attemptedToolCallsByMessage) {
      if (!isNameIncluded(toolCall.name, includeToolCallNames, excludeToolCallNames)) {
        continue;
      }
      const preHookResult = runPreCommandHooks({
        requestId: options.requestId,
        entryEndpoint: options.entryEndpoint,
        providerProtocol: options.providerProtocol,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        toolArguments: toolCall.arguments,
        preCommandState: runtimePreCommandState
      });
      for (const trace of preHookResult.traces) {
        traceAutoHook(options, trace);
      }
      if (preHookResult.changed && preHookResult.toolArguments !== toolCall.arguments) {
        toolCall.arguments = preHookResult.toolArguments;
        patchToolCallArgumentsById(base, toolCall.id, preHookResult.toolArguments);
        patchToolCallArgumentsById(baseForExecution, toolCall.id, preHookResult.toolArguments);
      }

      const entry = getServerToolHandler(toolCall.name);
      if (!entry || entry.trigger !== 'tool_call') {
        continue;
      }
      const ctx: ServerToolHandlerContext = { ...contextBase, base: baseForExecution, toolCall };
      let planned: ServerToolHandlerPlan | ServerToolHandlerResult | null = null;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          planned = await runHandler(entry.handler, ctx);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      const result = planned ? await materializePlannedResult(planned, options) : null;
      if (result) {
        replaceJsonObjectInPlace(baseForExecution, cloneJson(result.chatResponse) as JsonObject);
        executedToolCalls.push(toolCall);
        executedIds.add(toolCall.id);
        if (result.execution?.flowId && typeof result.execution.flowId === 'string' && result.execution.flowId.trim()) {
          executedFlowIds.push(result.execution.flowId.trim());
        }
        lastExecution = result.execution;
        continue;
      }
      if (lastErr) {
        // Handler failed: report tool error as a tool_output, but do not crash the whole pipeline.
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
        appendToolOutput(
          baseForExecution,
          toolCall.id,
          toolCall.name,
          JSON.stringify({ ok: false, tool: toolCall.name, message, retryable: true })
        );
        // Preserve failed tool_calls for the client; do not mark as executed.
        executedFlowIds.push(`${toolCall.name}_error`);
      }
    }
  }

  if (executedToolCalls.length > 0) {
    const clientResponse = cloneJson(base) as JsonObject;
    filterOutExecutedToolCalls(clientResponse, executedIds);
    stripToolOutputs(clientResponse);

    // Determine whether any non-executed tool_calls remain (client tools).
    const remainingToolCalls: string[] = [];
    const remainingChoices = getArray((clientResponse as any).choices);
    for (const choice of remainingChoices) {
      const choiceObj = asObject(choice);
      if (!choiceObj) continue;
      const message = asObject((choiceObj as any).message);
      if (!message) continue;
      const toolCallsArr = getArray((message as any).tool_calls);
      for (const tc of toolCallsArr) {
        if (!tc || typeof tc !== 'object' || Array.isArray(tc)) continue;
        const id = typeof (tc as any).id === 'string' ? String((tc as any).id).trim() : '';
        if (id) remainingToolCalls.push(id);
      }
    }

    if (remainingToolCalls.length > 0) {
      const sessionId =
        options.adapterContext && typeof (options.adapterContext as any).sessionId === 'string'
          ? String((options.adapterContext as any).sessionId).trim()
          : '';
      const allowIds = new Set<string>(executedToolCalls.map((t) => t.id));
      const injectionMessages: JsonObject[] = [
        buildAssistantToolCallMessage(executedToolCalls),
        ...buildToolMessagesFromOutputs(baseForExecution, allowIds)
      ];
      return {
        mode: 'tool_flow',
        finalChatResponse: clientResponse,
        execution: { flowId: 'servertool_mixed' },
        ...(sessionId && injectionMessages.length
          ? {
            pendingInjection: {
              sessionId,
              afterToolCallIds: remainingToolCalls,
              messages: injectionMessages
            }
          }
          : {})
      };
    }

    // Servertool-only: keep tool_outputs and ask orchestration layer to followup/reenter.
    const genericFollowup = {
      requestIdSuffix: ':servertool_followup',
      injection: {
        ops: [
          { op: 'append_assistant_message', required: true },
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      }
    } as any;
    const followup =
      executedToolCalls.length === 1 && lastExecution?.followup ? lastExecution.followup : genericFollowup;
    const flowId =
      executedToolCalls.length === 1
        ? (lastExecution?.flowId ?? executedFlowIds[0] ?? executedToolCalls[0].name)
        : 'servertool_multi';
    return {
      mode: 'tool_flow',
      finalChatResponse: baseForExecution,
      execution: {
        ...(lastExecution && executedToolCalls.length === 1 ? lastExecution : ({ flowId } as any)),
        flowId,
        followup
      }
    };
  }

  const autoHookExecutionList = listAutoServerToolHooks();
  const filteredAutoHooks = autoHookExecutionList.filter((hook) =>
    isNameIncluded(hook.id, includeAutoHookIds, excludeAutoHookIds)
  );
  const { optionalQueue, mandatoryQueue } = buildAutoHookQueues(filteredAutoHooks);

  const optionalResult = await runAutoHookQueue({
    queueName: 'A_optional',
    hooks: optionalQueue,
    options,
    contextBase: contextBase as ServerToolHandlerContext
  });
  if (optionalResult) {
    return {
      mode: 'tool_flow',
      finalChatResponse: optionalResult.chatResponse,
      execution: optionalResult.execution
    };
  }

  const mandatoryResult = await runAutoHookQueue({
    queueName: 'B_mandatory',
    hooks: mandatoryQueue,
    options,
    contextBase: contextBase as ServerToolHandlerContext
  });
  if (mandatoryResult) {
    return {
      mode: 'tool_flow',
      finalChatResponse: mandatoryResult.chatResponse,
      execution: mandatoryResult.execution
    };
  }

  return { mode: 'passthrough', finalChatResponse: base };
}

async function runAutoHookQueue(options: {
  queueName: AutoHookQueueName;
  hooks: AutoHookDescriptor[];
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
}): Promise<ServerToolHandlerResult | null> {
  const queueTotal = options.hooks.length;
  for (let idx = 0; idx < options.hooks.length; idx += 1) {
    const hook = options.hooks[idx];
    const traceBase: Omit<ServerToolAutoHookTraceEvent, 'result' | 'reason' | 'flowId'> = {
      hookId: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      queue: options.queueName,
      queueIndex: idx + 1,
      queueTotal
    };

    let planned: ServerToolHandlerPlan | ServerToolHandlerResult | null = null;
    try {
      planned = await runHandler(hook.handler, options.contextBase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      traceAutoHook(options.options, {
        ...traceBase,
        result: 'error',
        reason: message
      });
      throw error;
    }

    if (!planned) {
      traceAutoHook(options.options, {
        ...traceBase,
        result: 'miss',
        reason: 'predicate_false'
      });
      continue;
    }

    const result = await materializePlannedResult(planned, options.options);
    if (result) {
      const flowId =
        result.execution && typeof result.execution.flowId === 'string' && result.execution.flowId.trim()
          ? result.execution.flowId.trim()
          : undefined;
      traceAutoHook(options.options, {
        ...traceBase,
        result: 'match',
        reason: flowId ? 'matched' : 'matched_without_flow',
        ...(flowId ? { flowId } : {})
      });
      return result;
    }

    traceAutoHook(options.options, {
      ...traceBase,
      result: 'miss',
      reason: 'empty_materialized_result'
    });
  }

  return null;
}

async function runHandler(
  handler: (ctx: ServerToolHandlerContext) => Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null>,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null> {
  try {
    return await handler(ctx);
  } catch (error) {
    const toolName =
      ctx && ctx.toolCall && typeof ctx.toolCall.name === 'string' && ctx.toolCall.name.trim()
        ? ctx.toolCall.name.trim()
        : 'auto';
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const wrapped = new ProviderProtocolError(`[servertool] handler failed: ${toolName}: ${message}`, {
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        toolName,
        requestId: ctx.requestId,
        entryEndpoint: ctx.entryEndpoint,
        providerProtocol: ctx.providerProtocol,
        error: message
      }
    }) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.status = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function materializePlannedResult(
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> {
  if (planned && typeof planned === 'object' && !Array.isArray(planned) && typeof (planned as any).finalize === 'function') {
    const plan = planned as ServerToolHandlerPlan;
    const backendResult = plan.backend ? await executeBackendPlan(plan.backend, options) : undefined;
    return await plan.finalize({ ...(backendResult ? { backendResult } : {}) });
  }
  return planned as ServerToolHandlerResult;
}

async function executeBackendPlan(
  plan: ServerToolBackendPlan,
  options: ServerSideToolEngineOptions
): Promise<ServerToolBackendResult | undefined> {
  if (!plan) return undefined;
  if (plan.kind === 'vision_analysis') {
    if (!options.reenterPipeline) return undefined;
    return await executeVisionBackendPlan({ plan, options });
  }
  if (plan.kind === 'web_search') {
    return await executeWebSearchBackendPlan({ plan, options });
  }
  return undefined;
}

export function extractToolCalls(chatResponse: JsonObject): ToolCall[] {
  const choices = getArray(chatResponse.choices);
  const calls: ToolCall[] = [];
  for (const choice of choices) {
    const choiceObj = asObject(choice);
    if (!choiceObj) continue;
    const message = asObject(choiceObj.message);
    if (!message) continue;
    const toolCalls = getArray(message.tool_calls);
    for (const raw of toolCalls) {
      const tc = asObject(raw);
      if (!tc) continue;
      const id = ensureToolCallId(tc as Record<string, unknown>);
      const fn =
        asObject((tc as Record<string, unknown>).function) ??
        asObject((tc as Record<string, unknown>).functionCall) ??
        asObject((tc as Record<string, unknown>).function_call);
      const name = fn && typeof fn.name === 'string' && fn.name.trim() ? fn.name.trim() : '';
      const rawArgs =
        (fn ? (fn as Record<string, unknown>).arguments : undefined) ??
        (fn ? (fn as Record<string, unknown>).args : undefined) ??
        (fn ? (fn as Record<string, unknown>).input : undefined) ??
        (tc as Record<string, unknown>).arguments ??
        (tc as Record<string, unknown>).args ??
        (tc as Record<string, unknown>).input;
      let args = '';
      if (typeof rawArgs === 'string') {
        args = rawArgs;
      } else if (rawArgs && typeof rawArgs === 'object') {
        try {
          args = JSON.stringify(rawArgs);
        } catch {
          args = '';
        }
      } else if (rawArgs !== undefined && rawArgs !== null) {
        args = String(rawArgs);
      }
      if (!name) continue;
      calls.push({ id, name, arguments: args });
    }
  }
  return calls;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function getArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isClientDisconnected(adapterContext: AdapterContext): boolean {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return false;
  }
  const state = (adapterContext as { clientConnectionState?: unknown }).clientConnectionState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const disconnected = (state as { disconnected?: unknown }).disconnected;
    if (disconnected === true) {
      return true;
    }
    if (typeof disconnected === 'string' && disconnected.trim().toLowerCase() === 'true') {
      return true;
    }
  }
  const raw = (adapterContext as { clientDisconnected?: unknown }).clientDisconnected;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

export function extractTextFromChatLike(payload: JsonObject): string {
  let current: JsonObject = payload;
  const visited = new Set<JsonObject>();
  while (current && typeof current === 'object' && !Array.isArray(current) && !visited.has(current)) {
    visited.add(current);
    if (Array.isArray((current as { choices?: unknown }).choices) || Array.isArray((current as { output?: unknown }).output)) {
      break;
    }
    const data = (current as { data?: unknown }).data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      current = data as JsonObject;
      continue;
    }
    const response = (current as { response?: unknown }).response;
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      current = response as JsonObject;
      continue;
    }
    break;
  }

  const choices = getArray((current as { choices?: unknown }).choices);
  if (!choices.length) return '';
  const first = asObject(choices[0]);
  if (!first) return '';
  const message = asObject(first.message);
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  const parts = getArray(content);
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      texts.push(part);
    } else if (part && typeof part === 'object') {
      const record = part as Record<string, JsonValue>;
      if (typeof record.text === 'string') {
        texts.push(record.text);
      } else if (typeof (record as { content?: unknown }).content === 'string') {
        texts.push((record as { content: string }).content);
      }
    }
  }
  const joinedFromChoices = texts.join('\n').trim();
  if (joinedFromChoices) {
    return joinedFromChoices;
  }

  const output = (current as { output?: unknown }).output;
  if (Array.isArray(output)) {
    const altTexts: string[] = [];
    for (const entry of output) {
      if (!entry || typeof entry !== 'object') continue;
      const blocks = (entry as { content?: unknown }).content;
      const blockArray = Array.isArray(blocks) ? blocks : [];
      for (const block of blockArray) {
        if (!block || typeof block !== 'object') continue;
        const record = block as { text?: unknown; output_text?: unknown; content?: unknown };
        if (typeof record.text === 'string') {
          altTexts.push(record.text);
        } else if (typeof record.output_text === 'string') {
          altTexts.push(record.output_text);
        } else if (typeof record.content === 'string') {
          altTexts.push(record.content);
        }
      }
    }
    const joined = altTexts.join('\n').trim();
    if (joined) {
      return joined;
    }
  }

  const webSearchRaw =
    (current as { web_search?: unknown }).web_search ??
    (payload as { web_search?: unknown }).web_search;
  if (Array.isArray(webSearchRaw) && webSearchRaw.length > 0) {
    const items = webSearchRaw
      .filter((entry): entry is Record<string, JsonValue> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
      .slice(0, 5);
    const lines: string[] = [];
    items.forEach((item, index) => {
      const idx = (typeof item.refer === 'string' && item.refer.trim()) || String(index + 1);
      const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '';
      const media = typeof item.media === 'string' && item.media.trim() ? item.media.trim() : '';
      const date = typeof item.publish_date === 'string' && item.publish_date.trim() ? item.publish_date.trim() : '';
      const contentText = typeof item.content === 'string' && item.content.trim() ? item.content.trim() : '';
      const link = typeof item.link === 'string' && item.link.trim() ? item.link.trim() : '';

      const headerParts: string[] = [];
      if (title) headerParts.push(title);
      if (media) headerParts.push(media);
      if (date) headerParts.push(date);
      const header = headerParts.length ? headerParts.join(' · ') : undefined;

      const segments: string[] = [];
      segments.push(`【${idx}】${header ?? '搜索结果'}`);
      if (contentText) segments.push(contentText);
      if (link) segments.push(link);

      lines.push(segments.join('\n'));
    });
    const combined = lines.join('\n\n').trim();
    if (combined) {
      return combined;
    }
  }

  return '';
}
