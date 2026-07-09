import { normalizeChatRequest } from './openai-message-normalize.js';
import { createSnapshotWriter } from '../snapshot-utils.js';
import {
  failNativeRequired,
  isNativeDisabledByEnv
} from '../../native/router-hotpath/native-router-hotpath-loader.js';
import { loadNativeRouterHotpathBindingForInternalUse } from '../../native/router-hotpath/native-router-hotpath.js';
import { pruneChatRequestPayloadWithNative } from '../../native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';

type ChatRequestFilterProfile = {
  incomingProtocol: string;
  outgoingProtocol: string;
};

type ChatRequestFilterContext = {
  requestId?: string;
  endpoint?: string;
  entryEndpoint?: string;
  metadata?: Record<string, unknown>;
};

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseOutputRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildGovernedFilterPayloadWithNative(
  request: unknown,
  context?: unknown
): Record<string, unknown> {
  const capability = context === undefined
    ? 'buildGovernedFilterPayloadJson'
    : 'buildGovernedFilterPayloadWithContextJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request);
  if (!requestJson) {
    return fail('json stringify failed');
  }
  const contextJson = context === undefined ? undefined : safeStringify(context);
  if (context !== undefined && !contextJson) {
    return fail('context json stringify failed');
  }

  try {
    const raw = contextJson === undefined ? fn(requestJson) : fn(requestJson, contextJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOutputRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

/**
 * Native-primary Chat request filters.
 */
export async function runStandardChatRequestFilters(
  chatRequest: any,
  profile: ChatRequestFilterProfile,
  context: ChatRequestFilterContext
): Promise<any> {
  const existingMetadata = context.metadata ?? {};
  if (!context.metadata) {
    context.metadata = existingMetadata;
  }
  const inboundStreamFromContext =
    typeof existingMetadata.inboundStream === 'boolean' ? (existingMetadata.inboundStream as boolean) : undefined;
  const inboundStreamDetected =
    chatRequest && typeof chatRequest === 'object' && (chatRequest as any).stream === true ? true : undefined;
  const normalizedInboundStream = inboundStreamFromContext ?? inboundStreamDetected;
  if (typeof normalizedInboundStream === 'boolean') {
    existingMetadata.inboundStream = normalizedInboundStream;
  }

  const requestId = context.requestId ?? `req_${Date.now()}`;
  const endpoint = context.entryEndpoint || context.endpoint || '/v1/chat/completions';

  const snapshot = createSnapshotWriter({
    requestId,
    endpoint,
    folderHint: 'openai-chat'
  });
  const snapshotStage = (stage: string, payload: unknown) => {
    if (!snapshot) return;
    snapshot(stage, payload);
  };
  snapshotStage('req_process_filters_input', chatRequest);

  const nativeGovernedPayload = buildGovernedFilterPayloadWithNative(chatRequest, {
    incomingProtocol: profile.incomingProtocol,
    entryEndpoint: endpoint,
  });
  snapshotStage('req_process_filters_native_payload', nativeGovernedPayload);

  let normalized = normalizeChatRequest(nativeGovernedPayload);
  snapshotStage('req_process_filters_normalized', normalized);

  const preserveStreamField =
    profile.incomingProtocol === 'openai-chat' && profile.outgoingProtocol === 'openai-chat';

  const pruned = pruneChatRequestPayloadWithNative(normalized, preserveStreamField);
  snapshotStage('req_process_filters_output', pruned);
  return pruned;
}
