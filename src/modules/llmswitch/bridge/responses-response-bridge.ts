/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for Responses JSON projection and
 * direct-continuation response projection IO.
 */

// feature_id: server.responses_response_handler_bridge_surface
// canonical_builders: rebindResponsesConversationRequestIdForHttp, normalizeResponsesClientPayloadForHttp

import type { AnyRecord } from './module-loader.js';
import {
  importCoreDist,
  rebindResponsesConversationRequestId,
  requireCoreDist,
} from './index.js';
import {
  clearResponsesConversationByRequestId,
} from './runtime-integrations.js';
import {
  projectResponsesClientPayloadForClientNative,
} from './native-exports.js';
import {
  readRuntimeRequestTruthIdentifiers,
} from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';
import { stripInternalKeysDeep } from '../../../utils/strip-internal-keys.js';

export type ResponsesRequestContextForHttp = {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

function asRecordForHttp(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const RESPONSES_DEBUG = (process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() === '1';

function summarizeDebugToolsForHttp(tools: unknown): Record<string, unknown> {
  const list = Array.isArray(tools) ? tools : [];
  return {
    count: list.length,
    names: list.map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return 'unknown';
      }
      const row = tool as Record<string, unknown>;
      const directName = typeof row.name === 'string' ? row.name.trim() : '';
      if (directName) {
        return directName;
      }
      const fn =
        row.function && typeof row.function === 'object' && !Array.isArray(row.function)
          ? (row.function as Record<string, unknown>)
          : undefined;
      const fnName = typeof fn?.name === 'string' ? fn.name.trim() : '';
      return fnName || 'unknown';
    }),
  };
}

export function buildResponsesRequestLogContextForHttp(args: {
  metadata?: unknown;
  usageLogInfo?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const metadata = asRecordForHttp(args.metadata);
  const usageLogInfo = asRecordForHttp(args.usageLogInfo);
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  return {
    logSessionColorKey: usageLogInfo.logSessionColorKey ?? metadata.logSessionColorKey,
    clientTmuxSessionId: usageLogInfo.clientTmuxSessionId ?? metadata.clientTmuxSessionId,
    client_tmux_session_id: usageLogInfo.client_tmux_session_id ?? metadata.client_tmux_session_id,
    tmuxSessionId: usageLogInfo.tmuxSessionId ?? metadata.tmuxSessionId,
    tmux_session_id: usageLogInfo.tmux_session_id ?? metadata.tmux_session_id,
    rccSessionClientTmuxSessionId:
      usageLogInfo.rccSessionClientTmuxSessionId ?? metadata.rccSessionClientTmuxSessionId,
    rcc_session_client_tmux_session_id:
      usageLogInfo.rcc_session_client_tmux_session_id ?? metadata.rcc_session_client_tmux_session_id,
    sessionId: usageLogInfo.sessionId ?? requestTruth.sessionId,
    session_id: usageLogInfo.session_id ?? requestTruth.sessionId,
    conversationId: usageLogInfo.conversationId ?? requestTruth.conversationId,
    conversation_id: usageLogInfo.conversation_id ?? requestTruth.conversationId
  };
}

export async function rebindResponsesConversationRequestIdForHttp(
  oldId?: string,
  newId?: string
): Promise<void> {
  await rebindResponsesConversationRequestId(oldId, newId);
}
export function requireResponsesHandlerCoreDist<TModule extends object>(
  specifier: string
): TModule {
  return requireCoreDist<TModule>(specifier);
}

export async function importResponsesHandlerCoreDist<TModule extends object>(
  specifier: string
): Promise<TModule> {
  return await importCoreDist<TModule>(specifier);
}

function readResponsesRequestModelForHttp(requestContext?: {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): string | undefined {
  const payloadModel = requestContext?.payload?.model;
  if (typeof payloadModel === 'string' && payloadModel.trim()) {
    return payloadModel.trim();
  }
  const contextModel = requestContext?.context?.model;
  if (typeof contextModel === 'string' && contextModel.trim()) {
    return contextModel.trim();
  }
  return undefined;
}

function readResponsesClientToolsRawForHttp(requestContext?: {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): unknown[] {
  const contextToolsRaw = requestContext?.context?.toolsRaw;
  if (Array.isArray(contextToolsRaw)) {
    return contextToolsRaw;
  }
  const contextClientToolsRaw = requestContext?.context?.clientToolsRaw;
  if (Array.isArray(contextClientToolsRaw)) {
    return contextClientToolsRaw;
  }
  const payloadTools = requestContext?.payload?.tools;
  if (Array.isArray(payloadTools)) {
    return payloadTools;
  }
  return [];
}

export async function normalizeResponsesClientPayloadForHttp(args: {
  payload: unknown;
  entryEndpoint?: string;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.payload;
  }
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    return args.payload;
  }
  const projectedPayload = projectResponsesClientPayloadForClientNative({
    payload: args.payload,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
  });
  return stripClientVisibleMetadataDeep(projectedPayload);
}

export async function prepareResponsesJsonClientDispatchPlanForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  metadata?: Record<string, unknown>;
  resolveBridge?: typeof importResponsesHandlerCoreDist;
}): Promise<{
  clientBody: unknown;
  sanitizedBody: unknown;
}> {
  const clientBody = await normalizeResponsesClientPayloadForHttp({
    payload: args.body,
    entryEndpoint: args.entryEndpoint,
    requestContext: args.requestContext,
    metadata: args.metadata,
  });
  return {
    clientBody,
    sanitizedBody: stripInternalKeysDeep(clientBody),
  };
}


function stripClientVisibleMetadataDeep<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripClientVisibleMetadataDeep(item)) as T;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'metadata') {
      continue;
    }
    out[key] = stripClientVisibleMetadataDeep(entry);
  }
  return out as T;
}
