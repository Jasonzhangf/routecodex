import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import { mapProviderProtocol, asRecord } from './provider-utils.js';
import { extractAnthropicToolAliasMap } from './anthropic-tool-alias.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../modules/llmswitch/bridge.js';
import { applyClientConnectionStateToContext } from '../../utils/client-connection-state.js';

export interface ConvertProviderResponseOptions {
  entryEndpoint?: string;
  providerType?: string;
  requestId: string;
  wantsStream: boolean;
  originalRequest?: Record<string, unknown> | undefined;
  processMode?: string;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
}

export interface ConvertProviderResponseDeps {
  logStage(stage: string, requestId: string, details?: Record<string, unknown>): void;
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
}

function extractClientModelId(
  metadata: Record<string, unknown>,
  originalRequest?: Record<string, unknown>
): string | undefined {
  const candidates = [
    metadata.clientModelId,
    metadata.originalModelId,
    (metadata.target && typeof metadata.target === 'object'
      ? (metadata.target as Record<string, unknown>).clientModelId
      : undefined),
    originalRequest && typeof originalRequest === 'object'
      ? (originalRequest as Record<string, unknown>).model
      : undefined,
    originalRequest && typeof originalRequest === 'object'
      ? (originalRequest as Record<string, unknown>).originalModelId
      : undefined
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  if (options.processMode === 'passthrough') {
    return options.response;
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  const body = options.response.body;
  if (!body || typeof body !== 'object') {
    return options.response;
  }

  try {
    const providerProtocol = mapProviderProtocol(options.providerType);
    const metadataBag = asRecord(options.pipelineMetadata);
    const aliasMap = extractAnthropicToolAliasMap(metadataBag);
    const originalModelId = extractClientModelId(metadataBag ?? {}, options.originalRequest);
    const baseContext: Record<string, unknown> = {
      ...(metadataBag ?? {})
    };
    if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
      baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
    }
    baseContext.requestId = options.requestId;
    baseContext.entryEndpoint = options.entryEndpoint || entry;
    baseContext.providerProtocol = providerProtocol;
    baseContext.originalModelId = originalModelId;
    applyClientConnectionStateToContext(metadataBag, baseContext);
    const adapterContext = baseContext;
    if (aliasMap) {
      (adapterContext as Record<string, unknown>).anthropicToolNameMap = aliasMap;
    }

    const stageRecorder = await bridgeCreateSnapshotRecorder(
      adapterContext,
      typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
        ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
        : entry
    );

    const providerInvoker = async (invokeOptions: {
      providerKey: string;
      payload: Record<string, unknown>;
      routeHint?: string;
    }): Promise<{ providerResponse: Record<string, unknown> }> => {
      if (invokeOptions.routeHint) {
        const carrier = invokeOptions.payload as { metadata?: Record<string, unknown> };
        const existingMeta =
          carrier.metadata && typeof carrier.metadata === 'object'
            ? (carrier.metadata as Record<string, unknown>)
            : {};
        carrier.metadata = {
          ...existingMeta,
          routeHint: existingMeta.routeHint ?? invokeOptions.routeHint
        };
      }

      const nestedInput: PipelineExecutionInput = {
        entryEndpoint: options.entryEndpoint || entry,
        method: 'POST',
        requestId: options.requestId,
        headers: {},
        query: {},
        body: invokeOptions.payload,
        metadata: {
          ...(metadataBag ?? {}),
          direction: 'request',
          stage: 'provider.invoke'
        }
      };
      const nestedResult = await deps.executeNested(nestedInput);
      const nestedBody =
        nestedResult.body && typeof nestedResult.body === 'object'
          ? (nestedResult.body as Record<string, unknown>)
          : (nestedResult as unknown as Record<string, unknown>);
      return { providerResponse: nestedBody };
    };

    const reenterPipeline = async (reenterOpts: {
      entryEndpoint: string;
      requestId: string;
      body: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
      const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
      const nestedExtra = asRecord(reenterOpts.metadata) ?? {};

      const nestedMetadata: Record<string, unknown> = {
        ...(metadataBag ?? {}),
        ...nestedExtra,
        entryEndpoint: nestedEntry,
        direction: 'request',
        stage: 'inbound'
      };

      const nestedInput: PipelineExecutionInput = {
        entryEndpoint: nestedEntry,
        method: 'POST',
        requestId: reenterOpts.requestId,
        headers: {},
        query: {},
        body: reenterOpts.body,
        metadata: nestedMetadata
      };
      const nestedResult = await deps.executeNested(nestedInput);
      const nestedBody =
        nestedResult.body && typeof nestedResult.body === 'object'
          ? (nestedResult.body as Record<string, unknown>)
          : undefined;
      return { body: nestedBody };
    };

    const converted = await bridgeConvertProviderResponse({
      providerProtocol,
      providerResponse: body as Record<string, unknown>,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      providerInvoker,
      stageRecorder,
      reenterPipeline
    });

    if (converted.__sse_responses) {
      return {
        ...options.response,
        body: { __sse_responses: converted.__sse_responses }
      };
    }

    return {
      ...options.response,
      body: converted.body ?? body
    };
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const providerProtocol = mapProviderProtocol(options.providerType);

    const isSseConvertFailure =
      typeof message === 'string' &&
      message.toLowerCase().includes('failed to convert sse payload');

    if (providerProtocol === 'gemini-chat' && isSseConvertFailure) {
      console.error(
        '[RequestExecutor] Fatal SSE decode error for Gemini provider, bubbling as HTTP error',
        error
      );
      throw error;
    }

    console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    throw error;
  }
}
