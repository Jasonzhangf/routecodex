import type { PipelineExecutionInput } from '../../handlers/types.js';
import type { HubPipelineExecutionResult, HubPipelineHandle } from './types.js';
import { createSnapshotRecorder as bridgeCreateSnapshotRecorder } from '../../../modules/llmswitch/bridge/snapshot-recorder.js';
import { asRecord } from './provider-utils.js';
import { MetadataCenter } from './metadata-center/metadata-center.js';
import {
  applyMetadataCenterRustWriteResult,
  buildMetadataCenterTransportSnapshot,
  type MetadataCenterRustSnapshot
} from './metadata-center/dualwrite-api.js';
import {
  buildRequestStageRuntimeControlWritePlanNative,
  executeHubPipelineNative,
  resolveEntryProtocolFromEndpointNative
} from '../../../modules/llmswitch/bridge/routing-integrations.js';
import { readHubPipelineNativeHandle } from './hub-pipeline-handle.js';

const truthy = new Set(['1', 'true', 'yes', 'on']);

const REQUEST_STAGE_RUNTIME_CONTROL_WRITER = {
  module: 'src/server/runtime/http-server/executor-pipeline.ts',
  symbol: 'runHubPipeline',
  stage: 'request_chatprocess_runtime_control'
} as const;

function resolveEntryProtocolFromEndpoint(entryEndpoint: string): 'openai-responses' | 'anthropic-messages' | 'openai-chat' {
  return resolveEntryProtocolFromEndpointNative(entryEndpoint) as 'openai-responses' | 'anthropic-messages' | 'openai-chat';
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

export function ensureHubPipeline(getHubPipeline: () => HubPipelineHandle | null): HubPipelineHandle {
  const pipeline = getHubPipeline();
  if (!readHubPipelineNativeHandle(pipeline)) {
    throw new Error('Hub pipeline runtime is not initialized');
  }
  return pipeline as HubPipelineHandle;
}

function buildHubPipelineMetadata(
  metadata: Record<string, unknown>,
  stageRecorder: unknown
): Record<string, unknown> {
  const pipelineMetadata = { ...metadata };
  delete pipelineMetadata.__raw_request_body;
  const center = MetadataCenter.read(metadata);
  if (center) {
    MetadataCenter.bind(pipelineMetadata, center);
  }
  if (stageRecorder && typeof stageRecorder === 'object') {
    pipelineMetadata.__hubStageRecorder = stageRecorder;
  } else {
    delete pipelineMetadata.__hubStageRecorder;
  }
  const metadataCenterSnapshot = buildMetadataCenterTransportSnapshot(pipelineMetadata);
  if (metadataCenterSnapshot) {
    pipelineMetadata.metadataCenterSnapshot = metadataCenterSnapshot;
  } else {
    delete pipelineMetadata.metadataCenterSnapshot;
  }
  return pipelineMetadata;
}

function syncRequestStageRuntimeControlToMetadataCenter(args: {
  sourceMetadata: Record<string, unknown>;
  outputMetadata: Record<string, unknown>;
}): Record<string, unknown> {
  const writePlan = buildRequestStageRuntimeControlWritePlanNative({
    outputMetadata: args.outputMetadata,
  });
  const runtimeControl = asRecord(writePlan.runtimeControl);
  if (!runtimeControl || Object.keys(runtimeControl).length === 0) {
    return args.outputMetadata;
  }
  if (!MetadataCenter.read(args.sourceMetadata)) {
    throw new Error('MetadataCenter runtime_control write failed: bound MetadataCenter missing');
  }
  const currentSnapshot = buildMetadataCenterTransportSnapshot(args.sourceMetadata) as MetadataCenterRustSnapshot | undefined;
  const nextRuntimeControl = {
    ...asRecord(currentSnapshot?.runtimeControl),
    ...runtimeControl,
  };
  const nextSnapshot: MetadataCenterRustSnapshot = {
    ...(currentSnapshot ?? {}),
    runtimeControl: nextRuntimeControl,
  };
  applyMetadataCenterRustWriteResult({
    target: args.sourceMetadata,
    snapshot: nextSnapshot,
    writer: REQUEST_STAGE_RUNTIME_CONTROL_WRITER,
    reason: 'rust request chatprocess runtime control'
  });
  const metadataCenterSnapshot = buildMetadataCenterTransportSnapshot(args.sourceMetadata);
  const outputMetadata = { ...args.outputMetadata };
  if (metadataCenterSnapshot) {
    outputMetadata.metadataCenterSnapshot = metadataCenterSnapshot;
  } else {
    delete outputMetadata.metadataCenterSnapshot;
  }
  return outputMetadata;
}

export async function runHubPipeline(
  hubPipeline: HubPipelineHandle,
  input: PipelineExecutionInput,
  metadata: Record<string, unknown>
): Promise<HubPipelineResult> {
  const providerProtocol = resolveEntryProtocolFromEndpoint(input.entryEndpoint);
  let stageRecorder: unknown;
  if (shouldEnableHubStageRecorder()) {
    try {
      stageRecorder = await bridgeCreateSnapshotRecorder(
        {
          requestId: input.requestId,
          providerProtocol
        },
        input.entryEndpoint
      );
    } catch (err) { console.warn('[executor-pipeline] createSnapshotRecorder failed (non-blocking):', err);
      stageRecorder = undefined;
    }
  }

  const payload = asRecord(input.body);
  const pipelineMetadata = buildHubPipelineMetadata(metadata, stageRecorder);
  const retryExclusionSet = pipelineMetadata.excludedProviderKeys;
  delete pipelineMetadata.excludedProviderKeys;
  const metadataCenterSnapshot = asRecord(pipelineMetadata.metadataCenterSnapshot);
  const { body: _nativeInputBody, ...nativeInputWithoutBody } = input;
  void _nativeInputBody;
  const pipelineInput: Omit<PipelineExecutionInput, 'body'> & {
    payload: Record<string, unknown>;
    endpoint: string;
    id: string;
    providerProtocol: 'openai-responses' | 'anthropic-messages' | 'openai-chat';
    retryExclusionSet?: unknown;
    metadataCenterSnapshot?: Record<string, unknown>;
  } = {
    ...nativeInputWithoutBody,
    id: input.requestId,
    endpoint: input.entryEndpoint,
    providerProtocol,
    ...(retryExclusionSet !== undefined ? { retryExclusionSet } : {}),
    metadata: pipelineMetadata,
    ...(metadataCenterSnapshot ? { metadataCenterSnapshot } : {}),
    payload
  };
  const handle = readHubPipelineNativeHandle(hubPipeline);
  if (!handle) {
    throw new Error('Hub pipeline runtime is not initialized');
  }
  const result = executeHubPipelineNative(
    handle,
    pipelineInput as unknown as Record<string, unknown>
  ) as unknown as HubPipelineExecutionResult;
  if (!result.providerPayload || !result.target?.providerKey) {
    throw Object.assign(new Error('Virtual router did not produce a provider target'), {
      code: 'ERR_NO_PROVIDER_TARGET',
      requestId: input.requestId
    });
  }
  const resultMetadata =
    result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
      ? syncRequestStageRuntimeControlToMetadataCenter({
        sourceMetadata: metadata,
        outputMetadata: result.metadata as Record<string, unknown>,
      })
      : {};
  const processMode = (resultMetadata.processMode as string | undefined) ?? 'chat';
  return {
    providerPayload: result.providerPayload,
    standardizedRequest:
      result.standardizedRequest && typeof result.standardizedRequest === 'object'
        ? (result.standardizedRequest as Record<string, unknown>)
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
    metadata: resultMetadata
  };
}
