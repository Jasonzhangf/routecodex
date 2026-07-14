import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
// feature_id: server.provider_response_conversion_host
import type { ProviderHandle, ProviderProtocol } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  buildChoicesArrayBridgeDebugDetailsWithNative,
  buildProviderResponseTimingBreakdownWithNative,
} from '../../../../modules/llmswitch/bridge/provider-response-converter-host.js';
import {
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
} from '../../../../modules/llmswitch/bridge/snapshot-recorder.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import {
  readRuntimeControlProjection,
  readRuntimeDebugSnapshotProjection,
} from '../metadata-center/request-truth-readers.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import { planProviderResponseMetadataSyncEffectNative } from '../../../../modules/llmswitch/bridge/provider-response-metadata-sync-host.js';
import {
  buildMetadataCenterTransportSnapshot,
  writeMetadataCenterSlot
} from '../metadata-center/dualwrite-api.js';

import {
  extractBridgeProviderResponsePayload,
  TRUTHY_VALUES,
  shouldAllowDirectResponsesPrebuiltSsePassthrough
} from './provider-response-shared-pure-blocks.js';

export function buildBridgeProviderResponseSeed(
  response: PipelineExecutionResult,
  body: unknown
): Record<string, unknown> | undefined {
  const responseRecord = response as unknown as Record<string, unknown>;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (
    responseRecord.data
    && typeof responseRecord.data === 'object'
    && !Array.isArray(responseRecord.data)
  ) {
    return responseRecord;
  }
  if (response.sseStream === undefined) {
    return undefined;
  }
  const seed: Record<string, unknown> = {
    sseStream: response.sseStream
  };
  if (typeof response.status === 'number') {
    seed.status = response.status;
  }
  if (response.headers && typeof response.headers === 'object' && !Array.isArray(response.headers)) {
    seed.headers = response.headers;
  }
  return seed;
}

type ProviderResponseStageRecorder = {
  record(stage: string, payload: object): void;
};

function buildBridgeInvocationMetadata(args: {
  metadata: Record<string, unknown>;
  requestId: string;
  entryEndpoint?: string;
  providerProtocol?: string;
  serverToolsEnabled?: boolean;
}): Record<string, unknown> {
  const bridgeMetadata: Record<string, unknown> = {
    ...args.metadata,
    requestId: args.requestId,
    ...(args.entryEndpoint ? { entryEndpoint: args.entryEndpoint } : {}),
    ...(args.providerProtocol ? { providerProtocol: args.providerProtocol } : {}),
    ...(args.serverToolsEnabled !== undefined ? { serverToolsEnabled: args.serverToolsEnabled } : {}),
  };
  const center = MetadataCenter.read(args.metadata);
  if (center) {
    MetadataCenter.bind(bridgeMetadata, center);
  }
  const metadataCenterSnapshot = buildMetadataCenterTransportSnapshot(bridgeMetadata);
  if (metadataCenterSnapshot) {
    bridgeMetadata.metadataCenterSnapshot = metadataCenterSnapshot;
  } else {
    delete bridgeMetadata.metadataCenterSnapshot;
  }
  return bridgeMetadata;
}

function logProviderResponseConverterNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  logExecutorRuntimeNonBlockingWarning({
    namespace: 'provider-response-converter',
    stage,
    error,
    details,
    throttleKey: stage
  });
}

function shouldEnableHubStageRecorder(): boolean {
  const raw = String(
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER
    ?? process.env.RCC_ENABLE_HUB_STAGE_RECORDER
    ?? ""
  ).trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}
function syncBridgeRuntimeBackToPipelineMetadata(options: {
  pipelineMetadata?: Record<string, unknown>;
  bridgeMetadata: Record<string, unknown>;
}): void {
  const pipelineMetadata = asRecord(options.pipelineMetadata);
  const bridgeCenter = MetadataCenter.read(options.bridgeMetadata);
  const pipelineCenter = MetadataCenter.read(pipelineMetadata);
  const plan = planProviderResponseMetadataSyncEffectNative({
    pipelineMetadataIsRecord: Boolean(pipelineMetadata),
    bridgeCenterExists: Boolean(bridgeCenter),
    pipelineCenterExists: Boolean(pipelineCenter),
    centersAreSame: Boolean(bridgeCenter && pipelineCenter && bridgeCenter === pipelineCenter),
    bridgeRuntimeControl: bridgeCenter?.readRuntimeControl() ?? {},
    bridgeDebugSnapshot: bridgeCenter?.readDebugSnapshot() ?? {},
  });
  if (plan.action === 'no_op') {
    return;
  }
  if (plan.action === 'bind_bridge_center') {
    if (!pipelineMetadata || !bridgeCenter) {
      throw new Error('provider response metadata sync bind action requires pipeline metadata and bridge MetadataCenter');
    }
    MetadataCenter.bind(pipelineMetadata, bridgeCenter);
    return;
  }
  if (plan.action !== 'apply_writes') {
    throw new Error(`unsupported provider response metadata sync action: ${String((plan as { action?: unknown }).action)}`);
  }
  if (!pipelineMetadata) {
    throw new Error('provider response metadata sync write action requires pipeline metadata');
  }
  for (const write of plan.writes) {
    writeMetadataCenterSlot({
      target: pipelineMetadata,
      family: write.family,
      key: write.key,
      value: write.value,
      writer: write.writer,
      reason: write.reason,
    });
  }
}

function readRuntimeControlForProviderResponseConverter(
  metadata?: Record<string, unknown>
): { providerProtocol?: string } {
  const runtimeControl = readRuntimeControlProjection(metadata);
  return {
    providerProtocol: runtimeControl.providerProtocol
  };
}

function readProviderProtocolForProviderResponseConverter(args: {
  metadata?: Record<string, unknown>;
  bridgeMetadata?: Record<string, unknown>;
}): ProviderProtocol {
  const providerProtocol = readRuntimeControlForProviderResponseConverter(
    args.metadata ?? args.bridgeMetadata
  ).providerProtocol;
  if (
    providerProtocol === 'openai-chat'
    || providerProtocol === 'openai-responses'
    || providerProtocol === 'anthropic-messages'
    || providerProtocol === 'gemini-chat'
  ) {
    return providerProtocol;
  }
  throw new Error('Provider response converter requires metadata center runtime_control.providerProtocol');
}

function asProviderResponseStageRecorder(value: unknown): ProviderResponseStageRecorder | undefined {
  if (value && typeof value === 'object' && typeof (value as { record?: unknown }).record === 'function') {
    return value as ProviderResponseStageRecorder;
  }
  return undefined;
}

export function buildResponseMetadataBagForProviderResponseConverter(args: {
  metadata?: Record<string, unknown>;
  providerFamily?: string;
}): Record<string, unknown> {
  const metadataBag = asRecord(args.metadata) ?? {};
  const providerFamily = typeof args.providerFamily === 'string' ? args.providerFamily.trim() : '';
  if (!providerFamily) {
    return metadataBag;
  }
  const responseMetadataBag: Record<string, unknown> = {
    ...metadataBag,
    providerFamily
  };
  const center = MetadataCenter.read(metadataBag);
  if (center) {
    MetadataCenter.bind(responseMetadataBag, center);
  }
  return responseMetadataBag;
}

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  providerFamily?: string;
  providerKey?: string;
  requestId: string;
  serverToolsEnabled?: boolean;
  wantsStream: boolean;
  processMode?: string;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
};

export type ConvertProviderResponseDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
};

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  let body = options.response.body;
  let bridgeSeedForError: Record<string, unknown> | undefined;
  let bridgePayloadForError: Record<string, unknown> | undefined;
  let bridgeProviderProtocolForError: string | undefined;
  if (body && typeof body === 'object') {
    const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
    if (wrapperError) {
      const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
      const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as Error & {
        response?: {
          data: {
            error: Record<string, unknown>;
          };
          status?: number;
        };
        details?: Record<string, unknown>;
      };
      error.response = {
        data: {
          error: {
            code: wrapperError.errorCode,
            message: wrapperError.upstreamError?.message ?? wrapperError.message,
            status: wrapperError.statusCode,
            type: wrapperError.upstreamError?.type,
            param: wrapperError.upstreamError?.param
          }
        },
        status: wrapperError.statusCode
      };
      error.details = {
        source: 'provider_response_sse_wrapper',
        rawMessage: wrapperError.message,
        ...(wrapperError.errorCode ? { rawCode: wrapperError.errorCode } : {}),
        ...(wrapperError.statusCode !== undefined ? { rawStatusCode: wrapperError.statusCode } : {}),
        ...(wrapperError.upstreamError ? { rawUpstreamError: wrapperError.upstreamError } : {})
      };
      throw error;
    }
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  const responseMetadataBag = buildResponseMetadataBagForProviderResponseConverter({
    metadata: asRecord(options.pipelineMetadata),
    providerFamily: options.providerFamily
  });
  const effectiveProviderProtocol = readProviderProtocolForProviderResponseConverter({ metadata: responseMetadataBag });
  const bridgeProviderResponseSeed = buildBridgeProviderResponseSeed(options.response, body);
  if (!bridgeProviderResponseSeed) {
    return options.response;
  }
  bridgeSeedForError = bridgeProviderResponseSeed;
  body = bridgeProviderResponseSeed;
  const isDirectResponsesPrebuiltSsePassthrough = shouldAllowDirectResponsesPrebuiltSsePassthrough({
    entryEndpoint: options.entryEndpoint || entry,
    providerProtocol: effectiveProviderProtocol,
    hasSseStream: options.response.sseStream !== undefined,
    continuationOwner: options.response.continuationOwner
  });
  if (isDirectResponsesPrebuiltSsePassthrough) {
    logPipelineStage('convert.bridge.prebuilt_sse_passthrough', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: effectiveProviderProtocol,
      continuationOwner: options.response.continuationOwner
    });
    return options.response;
  }
  try {
    const bridgeMetadata = buildBridgeInvocationMetadata({
      metadata: responseMetadataBag,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: effectiveProviderProtocol,
      serverToolsEnabled: options.serverToolsEnabled !== false
    });
    const bridgeProviderProtocol = readProviderProtocolForProviderResponseConverter({
      metadata: responseMetadataBag,
      bridgeMetadata
    });
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    let stageRecorder: ProviderResponseStageRecorder | undefined;
    if (shouldEnableHubStageRecorder()) {
      logPipelineStage('convert.snapshot_recorder.start', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: bridgeProviderProtocol
      });
      const snapshotRecorderStartMs = Date.now();
      stageRecorder = asProviderResponseStageRecorder(
        await bridgeCreateSnapshotRecorder(
          bridgeMetadata,
          typeof bridgeMetadata.entryEndpoint === 'string'
            ? bridgeMetadata.entryEndpoint
            : options.entryEndpoint || entry
        )
      );
      logPipelineStage('convert.snapshot_recorder.completed', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: bridgeProviderProtocol,
        elapsedMs: Date.now() - snapshotRecorderStartMs
      });
    }

    logPipelineStage('convert.bridge.start', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: bridgeProviderProtocol,
      wantsStream: options.wantsStream
    });
    const bridgeStartMs = Date.now();
    const bridgeProviderResponse =
      extractBridgeProviderResponsePayload(bridgeProviderResponseSeed)
      ?? bridgeProviderResponseSeed;
    bridgePayloadForError = bridgeProviderResponse;
    bridgeProviderProtocolForError = bridgeProviderProtocol;
    const converted = await bridgeConvertProviderResponse({
      providerProtocol: bridgeProviderProtocol,
      providerResponse: bridgeProviderResponse,
      context: bridgeMetadata,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      stageRecorder
    });
    syncBridgeRuntimeBackToPipelineMetadata({
      pipelineMetadata: options.pipelineMetadata,
      bridgeMetadata
    });
    logPipelineStage('convert.bridge.completed', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: bridgeProviderProtocol,
      hasSse: Boolean(converted.sseStream),
      hasBody: converted.body !== undefined && converted.body !== null,
      elapsedMs: Date.now() - bridgeStartMs
    });
    if (converted.sseStream) {
      const usage = converted.body
        ? extractUsageFromResult(
          { body: converted.body },
          {
            providerProtocol: bridgeProviderProtocol,
            providerType: options.providerType,
            providerKey: options.providerKey
          }
        )
        : undefined;
      const finishReason = deriveFinishReason(converted.body);
      logPipelineStage('convert.sse_wrapper_detected', options.requestId, {
        hasUsage: Boolean(usage),
        finishReason
      });
      return buildProviderResponseTimingBreakdownWithNative({
        ...options.response,
        body: converted.body,
        sseStream: converted.sseStream,
        usageLogInfo: {
          ...(options.response.usageLogInfo ?? {}),
          requestStartedAtMs: options.response.usageLogInfo?.requestStartedAtMs ?? Date.now(),
          ...(usage ? { usage: usage as Record<string, unknown> } : {})
        }
      });
    }
    void deriveFinishReason(converted.body ?? body);
    return buildProviderResponseTimingBreakdownWithNative({
      ...options.response,
      body: converted.body ?? body
    });
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const errRecord = err as Record<string, unknown>;
    const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
    const detailRecord = asRecord(errRecord.details);
    const detailUpstreamCode =
      typeof (detailRecord as Record<string, unknown> | undefined)?.upstreamCode === 'string'
        ? String((detailRecord as Record<string, unknown>).upstreamCode)
        : undefined;
    const detailReason =
      typeof (detailRecord as Record<string, unknown> | undefined)?.reason === 'string'
        ? String((detailRecord as Record<string, unknown>).reason)
        : typeof (detailRecord as Record<string, unknown> | undefined)?.error === 'string'
          ? String((detailRecord as Record<string, unknown>).error)
        : undefined;

    logPipelineStage('convert.bridge.error', options.requestId, {
      code: errCode,
      upstreamCode: upstreamCode || detailUpstreamCode,
      reason: detailReason,
      message,
      ...buildChoicesArrayBridgeDebugDetailsWithNative({
        message,
        bridgeProviderProtocol: bridgeProviderProtocolForError,
        bridgeSeed: bridgeSeedForError,
        bridgePayload: bridgePayloadForError
      })
    });
    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    throw error;
  }
}
