import type { PipelineExecutionInput } from '../../handlers/types.js';
import type { HubPipeline } from './types.js';
import { createSnapshotRecorder as bridgeCreateSnapshotRecorder } from '../../../modules/llmswitch/bridge.js';
import { asRecord } from './provider-utils.js';
import { MetadataCenter } from './metadata-center/metadata-center.js';

const truthy = new Set(['1', 'true', 'yes', 'on']);

function resolveEntryProtocolFromEndpoint(entryEndpoint: string): 'openai-responses' | 'anthropic-messages' | 'openai-chat' {
  const normalized = entryEndpoint.trim().toLowerCase();
  if (normalized.includes('/v1/responses')) {
    return 'openai-responses';
  }
  if (normalized.includes('/v1/messages')) {
    return 'anthropic-messages';
  }
  if (normalized.includes('/v1/chat/completions')) {
    return 'openai-chat';
  }
  throw new Error(`Unsupported hub pipeline entry endpoint: ${entryEndpoint}`);
}

function shouldEnableHubStageRecorder(): boolean {
  const raw = String(
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER
    ?? process.env.RCC_ENABLE_HUB_STAGE_RECORDER
    ?? ''
  ).trim().toLowerCase();
  return truthy.has(raw);
}

export type HubPipelineResult = {
  providerPayload: Record<string, unknown>;
  /**
   * Full standardized request produced by llmswitch-core. Carries canonical
   * semantics (e.g. tool alias maps) required for correct client remap.
   */
  standardizedRequest?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
  /**
   * Request after chat_process/tool governance. Carries canonical semantics
   * (e.g. tool alias maps) required for correct client remap.
   */
  processedRequest?: Record<string, unknown>;
  target: {
    providerKey: string;
    providerType: string;
    outboundProfile: string;
    runtimeKey?: string;
    concurrencyScopeKey?: string;
    processMode?: string;
    compatibilityProfile?: string;
  };
  routingDecision?: { routeName?: string; pool?: string[]; [key: string]: unknown };
  routingDiagnostics?: Record<string, unknown>;
  processMode: string;
  metadata: Record<string, unknown>;
};

export function ensureHubPipeline(getHubPipeline: () => HubPipeline | null): HubPipeline {
  const pipeline = getHubPipeline();
  if (!pipeline) {
    throw new Error('Hub pipeline runtime is not initialized');
  }
  return pipeline;
}

function buildHubPipelineMetadata(
  metadata: Record<string, unknown>,
  stageRecorder: unknown
): Record<string, unknown> {
  const pipelineMetadata = { ...metadata };
  const center = MetadataCenter.read(metadata);
  if (center) {
    MetadataCenter.bind(pipelineMetadata, center);
  }
  if (stageRecorder && typeof stageRecorder === 'object') {
    pipelineMetadata.__hubStageRecorder = stageRecorder;
  } else {
    delete pipelineMetadata.__hubStageRecorder;
  }
  return pipelineMetadata;
}

export async function runHubPipeline(
  hubPipeline: HubPipeline,
  input: PipelineExecutionInput,
  metadata: Record<string, unknown>
): Promise<HubPipelineResult> {
  let stageRecorder: unknown;
  if (shouldEnableHubStageRecorder()) {
    const providerProtocol = resolveEntryProtocolFromEndpoint(input.entryEndpoint);
    try {
      stageRecorder = await bridgeCreateSnapshotRecorder(
        {
          requestId: input.requestId,
          providerProtocol
        },
        input.entryEndpoint
      );
    } catch {
      stageRecorder = undefined;
    }
  }

  const payload = asRecord(input.body);
  const pipelineMetadata = buildHubPipelineMetadata(metadata, stageRecorder);
  const pipelineInput: PipelineExecutionInput & {
    payload: Record<string, unknown>;
    endpoint: string;
    id: string;
  } = {
    ...input,
    id: input.requestId,
    endpoint: input.entryEndpoint,
    metadata: pipelineMetadata,
    payload
  };
  const result = await hubPipeline.execute(pipelineInput);
  if (!result.providerPayload || !result.target?.providerKey) {
    throw Object.assign(new Error('Virtual router did not produce a provider target'), {
      code: 'ERR_NO_PROVIDER_TARGET',
      requestId: input.requestId
    });
  }
  const processMode = (result.metadata?.processMode as string | undefined) ?? 'chat';
  return {
    providerPayload: result.providerPayload,
    standardizedRequest:
      result.standardizedRequest && typeof result.standardizedRequest === 'object'
        ? (result.standardizedRequest as Record<string, unknown>)
        : undefined,
    entryOriginRequest:
      result.entryOriginRequest && typeof result.entryOriginRequest === 'object'
        ? (result.entryOriginRequest as Record<string, unknown>)
        : undefined,
    processedRequest:
      result.processedRequest && typeof result.processedRequest === 'object'
        ? (result.processedRequest as Record<string, unknown>)
        : undefined,
    target: result.target,
    routingDecision: result.routingDecision ?? undefined,
    routingDiagnostics:
      result.routingDiagnostics && typeof result.routingDiagnostics === 'object'
        ? (result.routingDiagnostics as Record<string, unknown>)
        : undefined,
    processMode,
    metadata: result.metadata ?? {}
  };
}
