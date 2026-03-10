import { evaluateResponsesHostPolicy } from '../responses-host-policy.js';
import { normalizeMessageReasoningTools } from '../../shared/reasoning-tool-normalizer.js';
import { createBridgeActionState, runBridgeActionPipeline } from '../../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../../bridge-policies.js';
import { consumeResponsesPayloadSnapshot, consumeResponsesPassthrough } from '../../shared/responses-reasoning-registry.js';
import {
  stripInternalToolingMetadata
} from '../../shared/responses-tool-utils.js';
import { ProviderProtocolError } from '../../provider-protocol-error.js';
import type { ResponsesRequestContext } from './types.js';
import {
  buildResponsesPayloadFromChatWithNative,
  normalizeResponsesToolCallArgumentsForClientWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { normalizeChatResponseReasoningToolsWithNative } from '../../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

function normalizeResponsesToolCallArgumentsForClient(responsesPayload: Record<string, unknown>, context?: ResponsesRequestContext): void {
  const toolsRaw = Array.isArray(context?.toolsRaw) ? (context?.toolsRaw as unknown[]) : [];
  if (!toolsRaw.length) {
    return;
  }
  const normalized = normalizeResponsesToolCallArgumentsForClientWithNative(responsesPayload, toolsRaw);
  for (const key of Object.keys(responsesPayload)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      delete (responsesPayload as Record<string, unknown>)[key];
    }
  }
  Object.assign(responsesPayload, normalized);
}

function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  let current: any = value;
  const seen = new Set<any>();
  while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
    seen.add(current);
    if ('choices' in current || 'message' in current) break;
    if ('data' in current && typeof (current as any).data === 'object') {
      current = (current as any).data;
      continue;
    }
    break;
  }
  return current as Record<string, unknown>;
}

function resolveSnapshotLookupKey(response: Record<string, unknown>, context?: ResponsesRequestContext): string | undefined {
  if (typeof (response as any)?.request_id === 'string') {
    return (response as any).request_id as string;
  }
  if (typeof context?.requestId === 'string') {
    return context.requestId;
  }
  if (typeof (response as any)?.id === 'string') {
    return (response as any).id as string;
  }
  return undefined;
}

function shouldStripHostManagedFields(context?: ResponsesRequestContext): boolean {
  const result = evaluateResponsesHostPolicy(context, typeof context?.targetProtocol === 'string' ? context?.targetProtocol : undefined);
  return result.shouldStripHostManagedFields;
}

function collectRetentionContext(context?: ResponsesRequestContext): {
  metadata?: Record<string, unknown>;
  stripHostManagedFields: boolean;
} {
  const stripHostManagedFields = shouldStripHostManagedFields(context);
  return {
    metadata: context?.metadata,
    stripHostManagedFields
  };
}

function readInlineRetentionPayload(
  response: Record<string, unknown>,
  key: '__responses_passthrough' | '__responses_payload_snapshot'
): Record<string, unknown> | undefined {
  const candidate = response[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

export function buildResponsesPayloadFromChat(payload: unknown, context?: ResponsesRequestContext): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const response = unwrapData(payload as Record<string, unknown>);
  if (!response || typeof response !== 'object') return payload;

  if ((response as any).object === 'response' && Array.isArray((response as any).output)) {
    return response;
  }

  const snapshotLookupKey = resolveSnapshotLookupKey(response as Record<string, unknown>, context);
  const snapshotPayload = snapshotLookupKey ? consumeResponsesPayloadSnapshot(snapshotLookupKey) : undefined;
  const passthroughPayload = snapshotLookupKey ? consumeResponsesPassthrough(snapshotLookupKey) : undefined;
  const sourceForRetention =
    (passthroughPayload && typeof passthroughPayload === 'object' ? passthroughPayload : undefined) ??
    readInlineRetentionPayload(response as Record<string, unknown>, '__responses_passthrough') ??
    (snapshotPayload && typeof snapshotPayload === 'object' ? snapshotPayload : undefined) ??
    readInlineRetentionPayload(response as Record<string, unknown>, '__responses_payload_snapshot');
  const retentionContext = collectRetentionContext(context);

  const hasChoicesArray = Array.isArray((response as any).choices);
  const choicesLength = hasChoicesArray ? ((response as any).choices as unknown[]).length : 0;

  if (!hasChoicesArray || choicesLength === 0) {
    const rawStatus = (response as any).status;
    const statusCode =
      typeof rawStatus === 'string' && rawStatus.trim().length
        ? rawStatus.trim()
        : typeof rawStatus === 'number'
          ? String(rawStatus)
          : undefined;
    const message =
      typeof (response as any).msg === 'string' && (response as any).msg.trim().length
        ? (response as any).msg.trim()
        : typeof (response as any).message === 'string' && (response as any).message.trim().length
          ? (response as any).message.trim()
          : 'Upstream returned non-standard Chat completion payload (missing choices).';

    const mergedFallback = buildResponsesPayloadFromChatWithNative(
      response as Record<string, unknown>,
      {
        requestId: context?.requestId,
        toolsRaw: Array.isArray(context?.toolsRaw) ? context?.toolsRaw : [],
        metadata: retentionContext.metadata,
        stripHostManagedFields: retentionContext.stripHostManagedFields,
        sourceForRetention: sourceForRetention as Record<string, unknown> | undefined
      }
    );
    if ((mergedFallback as any).metadata) {
      stripInternalToolingMetadata((mergedFallback as any).metadata);
    }
    return mergedFallback;
  }

  const canonical = normalizeChatResponseReasoningToolsWithNative(response as any) as any;
  const choices = Array.isArray(canonical?.choices) ? (canonical.choices as any[]) : [];
  const primaryChoice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
  const message = primaryChoice && typeof primaryChoice.message === 'object' ? (primaryChoice.message as Record<string, unknown>) : undefined;
  if (!message) {
    throw new ProviderProtocolError('Responses bridge could not locate assistant message in Chat completion', {
      code: 'MALFORMED_RESPONSE',
      protocol: 'openai-chat',
      providerType: 'openai',
      details: {
        context: 'buildResponsesPayloadFromChat',
        choicesLength: choices.length,
        requestId: context?.requestId
      }
    });
  }
  if (message) {
    try {
      const bridgePolicy = resolveBridgePolicy({ protocol: 'openai-responses', moduleType: 'openai-responses' });
      const policyActions = resolvePolicyActions(bridgePolicy, 'response_outbound');
      if (policyActions?.length) {
        const actionState = createBridgeActionState({ messages: [message] });
        runBridgeActionPipeline({
          stage: 'response_outbound',
          actions: policyActions,
          protocol: bridgePolicy?.protocol ?? 'openai-responses',
          moduleType: bridgePolicy?.moduleType ?? 'openai-responses',
          requestId: context?.requestId,
          state: actionState
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'unknown_error';
      try {
        // eslint-disable-next-line no-console
        console.error(
          `\x1b[31m[responses-bridge][response_outbound] bridge action pipeline failed requestId=${
            context?.requestId ?? 'unknown'
          } error=${errorMessage}\x1b[0m`
        );
      } catch {
        // ignore logging failures
      }
    }
  }
  if (message) {
    try {
      normalizeMessageReasoningTools(message, {
        idPrefix: `responses_reasoning_${context?.requestId ?? 'canonical'}`
      });
    } catch {
      // best-effort reasoning normalization
    }
  }
  const nativeBuilt = buildResponsesPayloadFromChatWithNative(response as Record<string, unknown>, {
    requestId: context?.requestId,
    toolsRaw: Array.isArray(context?.toolsRaw) ? context?.toolsRaw : [],
    metadata: retentionContext.metadata,
    stripHostManagedFields: retentionContext.stripHostManagedFields,
    sourceForRetention: sourceForRetention as Record<string, unknown> | undefined
  });

  const out: any = {
    ...nativeBuilt
  };
  normalizeResponsesToolCallArgumentsForClient(out, context);
  if ((out as any).metadata) {
    stripInternalToolingMetadata((out as any).metadata);
  }
  return out;
}

export function extractRequestIdFromResponse(response: any): string | undefined {
  if (response && typeof response === 'object' && 'metadata' in response && (response as any).metadata && typeof (response as any).metadata === 'object') {
    const meta = (response as any).metadata as Record<string, unknown>;
    if (typeof meta.requestId === 'string') return meta.requestId;
  }
  return undefined;
}
