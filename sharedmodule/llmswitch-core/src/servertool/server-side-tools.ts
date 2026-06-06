import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  listAutoServerToolHooks
} from './registry.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import './handlers/stop-message-auto.js';
import './handlers/vision.js';
import './handlers/fixture.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync } from '../router/virtual-router/routing-state-store.js';
import {
  detectEmptyAssistantPayloadContractSignalWithNative,
  planServertoolToolCallDispatchWithNative,
  runServertoolResponseStageWithNative
} from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import {
  buildServertoolDispatchPlanInput,
  resolveToolCallExecutionOutcome,
  runAutoHookExecutionQueue,
  runToolCallExecutionLoop
} from './execution-shell.js';
import {
  buildServertoolCliProjectionForAutoFlow,
  buildServertoolCliProjectionForToolCall
} from './cli-projection.js';
import { hasStopMessageAutoCliResultInRequest } from './cli-result-guard.js';
import {
  appendToolOutput,
  buildAutoHookQueuesFromConfig,
  filterOutExecutedToolCalls,
  patchToolCallArgumentsById,
  replaceJsonObjectInPlace,
  stripToolOutputs
} from './orchestration-blocks.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import { isStopEligibleForServerTool } from './stop-gateway-context.js';

type AutoHookQueueName = 'A_optional' | 'B_mandatory';
type AutoHookDescriptor = ReturnType<typeof listAutoServerToolHooks>[number];

const STOP_MESSAGE_AUTO_PROGRESSIVE_PROMPT =
  '请用启发式多段核对当前状态，不要只写“继续执行”：当前用户目标是什么；已完成步骤有哪些；是否已经完成目标；建议下一步是什么；证据如何核验；问题根因是什么；已排除哪些因素；排查顺序是什么；本轮 learned 是什么。若下一步存在，不要只总结，直接继续执行并补充文件、日志、命令输出或测试结果证据；若已完成或确实阻塞，给出简洁结论和可核验证据。';
const STOP_MESSAGE_AUTO_DEFAULT_MAX_REPEATS = 3;

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

export async function runServerSideToolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const base = asObject(options.chatResponse);
  if (!base) {
    return { mode: 'passthrough', finalChatResponse: options.chatResponse };
  }

  if (isClientDisconnected(options.adapterContext)) {
    throw Object.assign(new Error('[servertool] client disconnected before servertool execution'), {
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: { requestId: options.requestId }
    });
  }
  const toolCalls = extractToolCalls(base, options.requestId);
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
  const baseForExecution = cloneJson(base) as JsonObject;
  const runtimeMetadata = readRuntimeMetadata(options.adapterContext as unknown as Record<string, unknown>);
  const runtimePreCommandState = (() => {
    const directRuntime = asObject((options.adapterContext as Record<string, unknown> | undefined)?.__rt);
    const runtimeState =
      asObject(directRuntime?.preCommandState) ??
      asObject((runtimeMetadata as Record<string, unknown> | undefined)?.preCommandState);
    if (runtimeState) {
      return runtimeState;
    }
    const persistentScopeKey = resolveServertoolPersistentScopeKey(options.adapterContext);
    if (!persistentScopeKey) {
      return undefined;
    }
    try {
      const persistedState = loadRoutingInstructionStateSync(persistentScopeKey);
      return persistedState ? (JSON.parse(JSON.stringify(persistedState)) as JsonObject) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      const wrapped = new ProviderProtocolError(`[servertool] sticky routing state load failed: ${persistentScopeKey}: ${message}`, {
        code: 'SERVERTOOL_STATE_LOAD_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          stickyKey: persistentScopeKey,
          requestId: options.requestId,
          entryEndpoint: options.entryEndpoint,
          providerProtocol: options.providerProtocol,
          error: message
        }
      }) as ProviderProtocolError & { status?: number; cause?: unknown };
      wrapped.status = 500;
      wrapped.cause = error;
      throw wrapped;
    }
  })();

  const dispatchPlan = planServertoolToolCallDispatchWithNative(
    buildServertoolDispatchPlanInput({
      toolCalls,
      disableToolCallHandlers: options.disableToolCallHandlers === true,
      ...(includeToolCallNames ? { includeToolCallHandlerNames: [...includeToolCallNames] } : {}),
      ...(excludeToolCallNames ? { excludeToolCallHandlerNames: [...excludeToolCallNames] } : {}),
      runtimeMetadata
    })
  );

  if (dispatchPlan.executableToolCalls.length > 0) {
    const projection = buildServertoolCliProjectionForToolCall({
      options,
      toolCall: dispatchPlan.executableToolCalls[0],
      reasoningText: `RouteCodex intercepted servertool ${dispatchPlan.executableToolCalls[0].name} and will execute it through the client-visible CLI path.`
    });
    return {
      mode: 'tool_flow',
      finalChatResponse: projection.chatResponse,
      execution: {
        flowId: 'servertool_cli_projection',
        context: {
          servertoolCliProjection: projection.chatResponse.__servertool_cli_projection as JsonObject
        }
      }
    };
  }

  const executionState = await runToolCallExecutionLoop({
    dispatchPlan,
    options,
    contextBase,
    runtimePreCommandState,
    base,
    baseForExecution,
    patchToolCallArgumentsById,
    appendToolOutput
  });

  if (executionState.executedToolCalls.length > 0) {
    return resolveToolCallExecutionOutcome({
      base,
      baseForExecution,
      options,
      toolCalls,
      executionState,
      filterOutExecutedToolCalls,
      stripToolOutputs
    });
  }

  const payloadContractSignal = detectEmptyAssistantPayloadContractSignalWithNative(base);
  if (payloadContractSignal && !isStopEligibleForServerTool(base, options.adapterContext)) {
    return { mode: 'passthrough', finalChatResponse: base };
  }
  if (hasStopMessageAutoCliResultInRequest({ adapterContext: options.adapterContext, runtimeMetadata })) {
    return { mode: 'passthrough', finalChatResponse: base };
  }

  const autoHookExecutionList = listAutoServerToolHooks();
  const { optionalQueue, mandatoryQueue } = buildAutoHookQueuesFromConfig({
    hooks: autoHookExecutionList,
    includeAutoHookIds,
    excludeAutoHookIds
  });

  const optionalResult = await runAutoHookExecutionQueue({
    queueName: 'A_optional',
    hooks: optionalQueue,
    options,
    contextBase: contextBase as ServerToolHandlerContext
  });
  if (optionalResult) {
    if (optionalResult.execution.flowId === 'stop_message_flow') {
      const cliInput = buildStopMessageAutoCliInput(optionalResult.execution.context, optionalResult.execution.followup);
      const projection = buildServertoolCliProjectionForAutoFlow({
        options,
        flowId: optionalResult.execution.flowId,
        reasoningText: extractTextFromChatLike(optionalResult.chatResponse) || 'RouteCodex stopless continuation is projected to client CLI execution.',
        stdoutPreview: 'stopless continuation ready',
        input: cliInput
      });
      return {
        mode: 'tool_flow',
        finalChatResponse: projection.chatResponse,
        execution: {
          flowId: 'stop_message_flow',
          context: {
            servertoolCliProjection: projection.chatResponse.__servertool_cli_projection as JsonObject
          }
        }
      };
    }
    return {
      mode: 'tool_flow',
      finalChatResponse: optionalResult.chatResponse,
      execution: optionalResult.execution
    };
  }

  const mandatoryResult = await runAutoHookExecutionQueue({
    queueName: 'B_mandatory',
    hooks: mandatoryQueue,
    options,
    contextBase: contextBase as ServerToolHandlerContext
  });
  if (mandatoryResult) {
    if (mandatoryResult.execution.flowId === 'stop_message_flow') {
      const cliInput = buildStopMessageAutoCliInput(mandatoryResult.execution.context, mandatoryResult.execution.followup);
      const projection = buildServertoolCliProjectionForAutoFlow({
        options,
        flowId: mandatoryResult.execution.flowId,
        reasoningText: extractTextFromChatLike(mandatoryResult.chatResponse) || 'RouteCodex stopless continuation is projected to client CLI execution.',
        stdoutPreview: 'stopless continuation ready',
        input: cliInput
      });
      return {
        mode: 'tool_flow',
        finalChatResponse: projection.chatResponse,
        execution: {
          flowId: 'stop_message_flow',
          context: {
            servertoolCliProjection: projection.chatResponse.__servertool_cli_projection as JsonObject
          }
        }
      };
    }
    return {
      mode: 'tool_flow',
      finalChatResponse: mandatoryResult.chatResponse,
      execution: mandatoryResult.execution
    };
  }

  return { mode: 'passthrough', finalChatResponse: base };
}

function buildStopMessageAutoCliInput(context: unknown, followup: unknown): JsonObject {
  const out: JsonObject = {};
  const prompt = extractContinuationPromptFromFollowup(followup);
  out.continuationPrompt = normalizeStopMessageAutoCliPrompt(prompt);
  const contextRecord = asObject(context);
  if (contextRecord?.stopMessageCliInput && typeof contextRecord.stopMessageCliInput === 'object' && !Array.isArray(contextRecord.stopMessageCliInput)) {
    Object.assign(out, contextRecord.stopMessageCliInput as JsonObject);
  }
  const runtimeState = extractStopMessageRuntimeState(context, followup);
  const stopState = runtimeState.stopState;
  const loopState = runtimeState.loopState;
  const used = readNonNegativeInteger(stopState?.stopMessageUsed) ?? 0;
  const maxRepeats =
    readNonNegativeInteger(stopState?.stopMessageMaxRepeats) ??
    readNonNegativeInteger(loopState?.maxRepeats) ??
    STOP_MESSAGE_AUTO_DEFAULT_MAX_REPEATS;
  out.repeatCount = used;
  out.maxRepeats = maxRepeats;
  return out;
}

function extractStopMessageRuntimeState(context: unknown, followup: unknown): {
  stopState: Record<string, unknown> | null;
  loopState: Record<string, unknown> | null;
} {
  const followupRt = asObject(asObject(asObject(followup)?.metadata)?.__rt);
  const contextRecord = asObject(context);
  const contextRt = asObject(contextRecord?.__rt);
  const adapterRt = asObject(asObject(contextRecord?.adapterContext)?.__rt);
  const rt = followupRt ?? contextRt ?? adapterRt;
  return {
    stopState: asObject(rt?.stopMessageState),
    loopState: asObject(rt?.serverToolLoopState)
  };
}

function normalizeStopMessageAutoCliPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return STOP_MESSAGE_AUTO_PROGRESSIVE_PROMPT;
  }
  if (/^继续执行/.test(trimmed) && !trimmed.includes('当前用户目标')) {
    return STOP_MESSAGE_AUTO_PROGRESSIVE_PROMPT;
  }
  if (!trimmed.includes('当前用户目标') || !trimmed.includes('已完成步骤') || !trimmed.includes('learned')) {
    return `${STOP_MESSAGE_AUTO_PROGRESSIVE_PROMPT}\n\n${trimmed}`;
  }
  return trimmed;
}

function extractContinuationPromptFromFollowup(followup: unknown): string {
  const row = asObject(followup);
  const metadata = asObject(row?.metadata);
  const metadataText = typeof metadata?.clientInjectText === 'string' ? metadata.clientInjectText.trim() : '';
  if (metadataText) {
    return metadataText;
  }
  const injection = asObject(row?.injection);
  const ops = Array.isArray(injection?.ops) ? injection.ops : [];
  const texts: string[] = [];
  for (const op of ops) {
    const opRecord = asObject(op);
    if (opRecord?.op === 'append_user_text' && typeof opRecord.text === 'string' && opRecord.text.trim()) {
      texts.push(opRecord.text.trim());
    }
  }
  return texts.join('\n').trim();
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

export function extractToolCalls(chatResponse: JsonObject, requestId = ''): ToolCall[] {
  const stage = runServertoolResponseStageWithNative(chatResponse, requestId);
  const normalizedPayload = asObject(stage.normalizedPayload) ?? chatResponse;
  replaceJsonObjectInPlace(chatResponse, normalizedPayload);
  return stage.toolCalls.map((entry) => ({
    id: entry.id,
    name: entry.name,
    arguments: entry.arguments
  }));
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

// Explicit marker that a TS helper is operating under native servertool / router-hotpath contract.
// This keeps thin TS shells auditable without duplicating native semantics in multiple places.
export function bindServertoolContractWithNative<T>(value: T): T {
  return value;
}
