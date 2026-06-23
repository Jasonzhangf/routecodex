import type { AnyRecord } from './module-loader.js';
import { createResponsesJsonToSseConverter } from './runtime-integrations.js';
import {
  projectResponsesSseFrameForClientNative,
} from './native-exports.js';
import type { ResponsesRequestContextForHttp } from './responses-response-bridge.js';
import { projectResponsesClientPayloadForClientForHttp } from './responses-response-bridge.js';

export function buildClientSseKeepaliveFrameForHttp(_entryEndpoint?: string): string {
  return ': keepalive\n\n';
}

export function shouldDropClientSseFrameForHttp(frame: string, entryEndpoint?: string): boolean {
  return (
    (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs') &&
    frame.trim() === 'data: [DONE]'
  );
}

type ResponsesSseFrameSummaryForHttp = {
  event?: string;
  type?: string;
  status?: string;
  finishReason?: string;
  hasRequiredAction?: boolean;
  requiredToolCalls?: number;
  outputFunctionCalls?: number;
  dataParse?: 'non_json';
};

export function summarizeResponsesSseFrameForLogForHttp(frame: string): ResponsesSseFrameSummaryForHttp | null {
  const eventLine = frame
    .split(/\r?\n/)
    .find((line) => line.startsWith('event:'));
  const summary: ResponsesSseFrameSummaryForHttp = {
    ...(eventLine ? { event: eventLine.slice('event:'.length).trim() } : {}),
  };
  const dataLine = frame
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return Object.keys(summary).length > 0 ? summary : null;
  }
  const dataText = dataLine.slice('data:'.length).trim();
  if (!dataText || dataText === '[DONE]') {
    return Object.keys(summary).length > 0 ? summary : null;
  }
  try {
    const record = JSON.parse(dataText) as Record<string, unknown>;
    const response =
      record.response && typeof record.response === 'object' && !Array.isArray(record.response)
        ? record.response as Record<string, unknown>
        : undefined;
    const requiredAction =
      (record.required_action && typeof record.required_action === 'object' && !Array.isArray(record.required_action)
        ? record.required_action
        : response?.required_action) as Record<string, unknown> | undefined;
    const output = Array.isArray(record.output)
      ? record.output
      : Array.isArray(response?.output)
        ? response.output
        : [];
    const functionCallCount = output.filter((item) =>
      item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call'
    ).length;
    const requiredToolCalls =
      requiredAction
      && typeof requiredAction.submit_tool_outputs === 'object'
      && requiredAction.submit_tool_outputs
      && !Array.isArray(requiredAction.submit_tool_outputs)
      && Array.isArray((requiredAction.submit_tool_outputs as Record<string, unknown>).tool_calls)
        ? (((requiredAction.submit_tool_outputs as Record<string, unknown>).tool_calls as unknown[]).length)
        : undefined;
    if (typeof record.type === 'string') {
      summary.type = record.type;
    }
    if (typeof record.status === 'string') {
      summary.status = record.status;
    } else if (typeof response?.status === 'string') {
      summary.status = response.status;
    }
    if (typeof record.finish_reason === 'string') {
      summary.finishReason = record.finish_reason;
    } else if (typeof response?.finish_reason === 'string') {
      summary.finishReason = response.finish_reason;
    }
    if (requiredAction) {
      summary.hasRequiredAction = true;
    }
    if (requiredToolCalls !== undefined) {
      summary.requiredToolCalls = requiredToolCalls;
    }
    if (functionCallCount > 0) {
      summary.outputFunctionCalls = functionCallCount;
    }
    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    summary.dataParse = 'non_json';
    return summary;
  }
}

export function resolveResponsesProviderProtocolHintFromSseFrameForHttp(frame: string): string | undefined {
  if (/\bevent:\s*response\./.test(frame) || /"type"\s*:\s*"response\./.test(frame)) {
    return 'openai-responses';
  }
  if (/\bevent:\s*message_/.test(frame) || /"type"\s*:\s*"message_/.test(frame)) {
    return 'anthropic';
  }
  return undefined;
}

export async function createResponsesJsonToSseConverterForHttp() {
  return await createResponsesJsonToSseConverter();
}

export async function projectResponsesSseFrameForClientForHttp(args: {
  frame: string;
  eventName?: string;
  data: Record<string, unknown>;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
  state: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}): Promise<{
  emit: boolean;
  frame: string;
  state: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}> {
  return projectResponsesSseFrameForClientNative(args);
}

function readResponsesSseCallIdForHttp(data: Record<string, unknown>): string | undefined {
  const direct = data.call_id;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const item =
    data.item && typeof data.item === 'object' && !Array.isArray(data.item)
      ? data.item as Record<string, unknown>
      : undefined;
  const nested = item?.call_id;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function isApplyPatchFunctionCallRecordForHttp(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.type === 'function_call' && row.name === 'apply_patch';
}

function shouldSuppressDuplicateApplyPatchSseFrameForHttp(args: {
  eventName: string;
  data: Record<string, unknown>;
  state?: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}): boolean {
  const emitted = args.state?.emittedApplyPatchDoneCallIds ?? [];
  if (emitted.length === 0) {
    return false;
  }
  const callId = readResponsesSseCallIdForHttp(args.data);
  if (!callId || !emitted.includes(callId)) {
    return false;
  }
  if (
    args.eventName === 'response.function_call_arguments.delta'
    || args.eventName === 'response.function_call_arguments.done'
  ) {
    return true;
  }
  if (args.eventName === 'response.output_item.added' || args.eventName === 'response.output_item.done') {
    return isApplyPatchFunctionCallRecordForHttp(args.data.item);
  }
  return false;
}

function collectEmittedApplyPatchDoneCallIdsFromFrameForHttp(frame: string): string[] {
  const lines = frame.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (!eventLine || dataIndex < 0) {
    return [];
  }
  const eventName = eventLine.slice('event:'.length).trim();
  if (eventName !== 'response.output_item.done') {
    return [];
  }
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return [];
  }
  try {
    const parsed = JSON.parse(dataText) as Record<string, unknown>;
    const item =
      parsed.item && typeof parsed.item === 'object' && !Array.isArray(parsed.item)
        ? parsed.item as Record<string, unknown>
        : undefined;
    if (!item || item.type !== 'custom_tool_call' || item.name !== 'apply_patch') {
      return [];
    }
    const callId = item.call_id;
    return typeof callId === 'string' && callId.trim() ? [callId.trim()] : [];
  } catch {
    return [];
  }
}

function readResponsesClientToolsRawForHttp(requestContext?: ResponsesRequestContextForHttp): unknown[] {
  const payloadTools = Array.isArray(requestContext?.payload?.tools) ? requestContext.payload.tools : undefined;
  if (payloadTools?.length) {
    return payloadTools;
  }
  const contextTools = Array.isArray(requestContext?.context?.toolsRaw) ? requestContext.context.toolsRaw : undefined;
  if (contextTools?.length) {
    return contextTools;
  }
  const contextClientTools = Array.isArray(requestContext?.context?.clientToolsRaw)
    ? requestContext.context.clientToolsRaw
    : undefined;
  return contextClientTools?.length ? contextClientTools : [];
}

async function normalizeNestedResponsesPayloadInSseFrameForHttp(args: {
  frame: string;
  eventName: string;
  requestContext?: ResponsesRequestContextForHttp;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const lines = args.frame.split('\n');
  const eventIndex = lines.findIndex((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (eventIndex < 0 || dataIndex < 0) {
    return args.frame;
  }
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return args.frame;
  }
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return args.frame;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return args.frame;
  }
  const response =
    data.response && typeof data.response === 'object' && !Array.isArray(data.response)
      ? data.response
      : undefined;
  if (!response) {
    return args.frame;
  }
  const normalizedResponse = await projectResponsesClientPayloadForClientForHttp({
    payload: response,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
  });
  const nextData = {
    ...data,
    response: normalizedResponse,
  };
  lines[eventIndex] = `event: ${args.eventName}`;
  return `${lines.slice(0, dataIndex).join('\n')}${lines.slice(0, dataIndex).length ? '\n' : ''}data: ${JSON.stringify(nextData)}\n\n`;
}

export async function normalizeResponsesSseFrameForClientForHttp(args: {
  frame: string;
  entryEndpoint?: string;
  requestContext?: ResponsesRequestContextForHttp;
  metadata?: Record<string, unknown>;
  projectionState?: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
  requestLabel?: string;
}): Promise<string> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.frame;
  }
  const lines = args.frame.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (dataIndex < 0 || !eventLine) {
    return args.frame;
  }
  const eventName = eventLine.slice('event:'.length).trim();
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return args.frame;
  }
  if (!eventName.startsWith('response.')) {
    return args.frame;
  }
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return args.frame;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return args.frame;
  }
  if (shouldSuppressDuplicateApplyPatchSseFrameForHttp({
    eventName,
    data,
    state: args.projectionState,
  })) {
    return '';
  }
  const projected = await projectResponsesSseFrameForClientForHttp({
    frame: args.frame,
    eventName,
    data,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
    state: args.projectionState ?? {
      pendingApplyPatchArgumentDeltas: {},
      applyPatchCallIds: [],
      emittedApplyPatchDoneCallIds: [],
    },
  });
  if (args.projectionState) {
    args.projectionState.pendingApplyPatchArgumentDeltas = projected.state.pendingApplyPatchArgumentDeltas ?? {};
    args.projectionState.applyPatchCallIds = projected.state.applyPatchCallIds ?? [];
    args.projectionState.emittedApplyPatchDoneCallIds = Array.from(new Set([
      ...(args.projectionState.emittedApplyPatchDoneCallIds ?? []),
      ...(projected.state.emittedApplyPatchDoneCallIds ?? []),
    ]));
  }
  if (!projected.emit) {
    return '';
  }
  const normalizedFrame = await normalizeNestedResponsesPayloadInSseFrameForHttp({
    frame: projected.frame,
    eventName,
    requestContext: args.requestContext,
    metadata: args.metadata,
  });
  if (args.projectionState) {
    args.projectionState.emittedApplyPatchDoneCallIds = Array.from(new Set([
      ...(args.projectionState.emittedApplyPatchDoneCallIds ?? []),
      ...collectEmittedApplyPatchDoneCallIdsFromFrameForHttp(normalizedFrame),
    ]));
  }
  return normalizedFrame;
}
