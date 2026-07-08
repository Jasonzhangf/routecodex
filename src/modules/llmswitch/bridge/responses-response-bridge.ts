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
  planResponsesJsonClientDispatchNative,
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

function readTrimmedStringForHttp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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
  const sessionId =
    readTrimmedStringForHttp(usageLogInfo.sessionId)
    ?? readTrimmedStringForHttp(usageLogInfo.session_id)
    ?? readTrimmedStringForHttp(metadata.sessionId)
    ?? readTrimmedStringForHttp(metadata.session_id)
    ?? requestTruth.sessionId;
  const conversationId =
    readTrimmedStringForHttp(usageLogInfo.conversationId)
    ?? readTrimmedStringForHttp(usageLogInfo.conversation_id)
    ?? readTrimmedStringForHttp(metadata.conversationId)
    ?? readTrimmedStringForHttp(metadata.conversation_id)
    ?? requestTruth.conversationId;
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
    sessionId,
    session_id: sessionId,
    conversationId,
    conversation_id: conversationId
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
  const toolsRaw = args.requestContext?.context?.toolsRaw;
  if (!Array.isArray(toolsRaw)) {
    throw new Error('Responses client projection requires requestContext.context.toolsRaw');
  }
  return projectResponsesClientPayloadForClientNative({
    payload: args.payload,
    toolsRaw,
    metadata: args.metadata,
    context: args.requestContext
      ? {
          originalRequest: args.requestContext.payload,
          requestContext: args.requestContext.context,
        }
      : undefined,
  });
}

export async function prepareResponsesJsonClientDispatchPlanForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
  continuationOwner?: string;
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
  const dispatchPlan = planResponsesJsonClientDispatchNative({
    entryEndpoint: args.entryEndpoint,
    continuationOwner: args.continuationOwner,
    hasRequestContextToolsRaw: Array.isArray(args.requestContext?.context?.toolsRaw),
  });
  if (dispatchPlan.action === 'direct_passthrough') {
    return {
      clientBody: args.body,
      sanitizedBody: args.body,
    };
  }
  if (dispatchPlan.action !== 'project_client_payload') {
    throw new Error(
      `[responses] unsupported JSON client dispatch action: ${String(dispatchPlan.action ?? 'unknown')}`
    );
  }
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
