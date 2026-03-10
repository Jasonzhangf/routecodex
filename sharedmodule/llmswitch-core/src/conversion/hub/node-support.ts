import type { StandardizedRequest, ProcessedRequest } from './types/standardized.js';
import type { JsonObject } from './types/json.js';
import type { AdapterContext, ChatEnvelope } from './types/chat-envelope.js';
import type { HubNodeContext, HubNodeResult } from './types/node.js';
import { createProtocolPlans } from './registry.js';
import { runInboundPipeline } from './pipelines/inbound.js';
import { runOutboundPipeline } from './pipelines/outbound.js';
import { createSnapshotRecorder } from './snapshot-recorder.js';
import { ConversionError } from './types/errors.js';
import type { TargetMetadata } from '../../router/virtual-router/types.js';
import { isHubProtocolEnabled } from './hub-feature.js';
import { chatEnvelopeToStandardizedWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { standardizedToChatEnvelopeWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

export interface HubInboundOptions {
  protocol: string;
  rawRequest: Record<string, unknown>;
  nodeContext: HubNodeContext;
  nodeId: string;
  inputFormat: string;
  outputFormat: string;
  startTime: number;
}

export interface HubOutboundOptions {
  protocol: string;
  request: StandardizedRequest | ProcessedRequest;
  nodeContext: HubNodeContext;
}

export function shouldUseHub(protocol: string): boolean {
  return isHubProtocolEnabled(protocol);
}

export async function runHubInboundConversion(options: HubInboundOptions): Promise<HubNodeResult> {
  const adapterContext = deriveAdapterContext(options.nodeContext, options.protocol);
  const rawPayload = ensureJsonObject(options.rawRequest, options.nodeId);
  const stageRecorder = maybeCreateStageRecorder(adapterContext, options.nodeContext.request.endpoint);
  const { inbound } = createProtocolPlans(options.protocol);
  const chatEnvelope = await runInboundPipeline({
    rawRequest: rawPayload,
    context: adapterContext,
    plan: inbound,
    stageRecorder
  });
  const standardized = chatEnvelopeToStandardizedWithNative({
    chatEnvelope: chatEnvelope as unknown as Record<string, unknown>,
    adapterContext: adapterContext as unknown as Record<string, unknown>,
    endpoint: options.nodeContext.request.endpoint,
    requestId: options.nodeContext.request.id
  }) as unknown as StandardizedRequest;
  return buildHubNodeResult({
    nodeId: options.nodeId,
    startTime: options.startTime,
    standardized,
    inputFormat: options.inputFormat,
    outputFormat: options.outputFormat
  });
}

export async function runHubOutboundConversion(options: HubOutboundOptions): Promise<Record<string, unknown>> {
  const adapterContext = deriveAdapterContext(options.nodeContext, options.protocol);
  // Snapshots must be grouped by the client-facing entry endpoint, not by the provider protocol.
  // A /v1/responses request routed to an anthropic upstream is still a responses *entry* request.
  const stageRecorder = maybeCreateStageRecorder(adapterContext, options.nodeContext.request.endpoint);
  const { outbound } = createProtocolPlans(options.protocol);
  const chatEnvelope = standardizedToChatEnvelopeWithNative({
    request: options.request as unknown as JsonObject,
    adapterContext: adapterContext as unknown as Record<string, unknown>
  }) as unknown as ChatEnvelope;
  const payload = await runOutboundPipeline({
    chat: chatEnvelope,
    context: adapterContext,
    plan: outbound,
    stageRecorder
  });
  return payload;
}

function maybeCreateStageRecorder(adapterContext: AdapterContext, defaultEndpoint: string) {
  const flag = process.env.ROUTECODEX_HUB_SNAPSHOTS;
  if (flag && flag.trim() === '0') {
    return undefined;
  }
  const endpoint = defaultEndpoint || adapterContext.entryEndpoint || '/v1/chat/completions';
  return createSnapshotRecorder(adapterContext, endpoint);
}

function resolveEndpointForProtocol(protocol?: string): string | undefined {
  if (!protocol) return undefined;
  const value = protocol.toLowerCase();
  if (value === 'openai-responses') return '/v1/responses';
  if (value === 'openai-chat') return '/v1/chat/completions';
  if (value === 'anthropic-messages' || value === 'anthropic') return '/v1/messages';
  if (value === 'gemini' || value === 'google-gemini') return '/v1/responses';
  return undefined;
}

function ensureJsonObject(value: Record<string, unknown>, nodeId: string): JsonObject {
  if (!value || typeof value !== 'object') {
    throw new ConversionError('Hub inbound requires JSON object payload', nodeId);
  }
  return value as JsonObject;
}

function buildHubNodeResult(options: {
  nodeId: string;
  startTime: number;
  standardized: StandardizedRequest;
  inputFormat: string;
  outputFormat: string;
}): HubNodeResult {
  return {
    success: true,
    data: {
      standardizedRequest: options.standardized,
      originalFormat: options.inputFormat,
      targetFormat: options.outputFormat
    },
    metadata: {
      node: options.nodeId,
      executionTime: Date.now() - options.startTime,
      startTime: options.startTime,
      endTime: Date.now(),
      dataProcessed: {
        messages: options.standardized.messages.length,
        tools: options.standardized.tools?.length ?? 0
      }
    }
  };
}

function deriveAdapterContext(context: HubNodeContext, fallbackProtocol: string): AdapterContext {
  const requestContext = (context.request.context ?? {}) as Record<string, unknown>;
  const metadata = (requestContext.metadata ?? {}) as Record<string, unknown>;
  const target = metadata.target as TargetMetadata | undefined;
  const providerProtocol =
    (target?.outboundProfile as string | undefined) ||
    (typeof metadata.providerProtocol === 'string' ? (metadata.providerProtocol as string) : undefined) ||
    fallbackProtocol;

  const streamingHint =
    metadata.stream === true ? 'force' : metadata.stream === false ? 'disable' : 'auto';
  const toolCallIdStyle = normalizeToolCallIdStyleCandidate(metadata.toolCallIdStyle);

  return {
    requestId: context.request.id,
    entryEndpoint:
      (typeof requestContext.entryEndpoint === 'string' ? requestContext.entryEndpoint : context.request.endpoint) ||
      '/v1/chat/completions',
    providerProtocol,
    providerId: (target?.providerKey || metadata.providerKey) as string | undefined,
    routeId: metadata.routeName as string | undefined,
    profileId: metadata.pipelineId as string | undefined,
    streamingHint,
    toolCallIdStyle
  };
}

function normalizeToolCallIdStyleCandidate(value: unknown): 'fc' | 'preserve' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'fc') {
    return 'fc';
  }
  if (normalized === 'preserve') {
    return 'preserve';
  }
  return undefined;
}
