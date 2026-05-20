import type { ResponsesRequestContext } from '../../../../../responses/responses-openai-bridge.js';
import { runReqInboundStage3ContextCaptureOrchestration } from './context-capture-orchestration.js';
import {
  buildReqInboundToolOutputSnapshotWithNative,
  captureReqInboundResponsesContextSnapshotWithNative,
  normalizeProviderProtocolTokenWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import type {
  ContextCaptureHandler,
  ContextCaptureOptions,
  ReqInboundStage3ContextCaptureOptions
} from './context-capture-orchestration.js';
import { writeCacheEntryForRequest } from './cache-write.js';

export type {
  ContextCaptureHandler,
  ContextCaptureOptions,
  ReqInboundStage3ContextCaptureOptions
} from './context-capture-orchestration.js';

export async function runReqInboundStage3ContextCapture(
  options: ReqInboundStage3ContextCaptureOptions
): Promise<Record<string, unknown> | undefined> {
  return runReqInboundStage3ContextCaptureOrchestration(options);
}

export function runChatContextCapture(
  options: ContextCaptureOptions
): Promise<Record<string, unknown> | undefined> {
  return runReqInboundStage3ContextCapture({
    rawRequest: options.rawRequest,
    adapterContext: options.adapterContext,
    stageRecorder: options.stageRecorder,
    captureContext: captureChatContextSnapshot
  });
}

export function captureResponsesContextSnapshot(
  options: ContextCaptureOptions
): ResponsesRequestContext {
  // Write request to CACHE.md (responses input)
  writeCacheEntryForRequest(options);
  const context = captureReqInboundResponsesContextSnapshotWithNative({
    rawRequest: options.rawRequest as unknown as Record<string, unknown>,
    requestId: options.adapterContext.requestId,
    toolCallIdStyle: (options.adapterContext as Record<string, unknown>).toolCallIdStyle as string | undefined,
  }) as unknown as ResponsesRequestContext;
  return context;
}

function captureChatContextSnapshot(options: ContextCaptureOptions): Record<string, unknown> {
  const protocol = normalizeProviderProtocolTokenWithNative(options.adapterContext.providerProtocol);
  writeCacheEntryForRequest(options);
  return buildReqInboundToolOutputSnapshotWithNative(
    options.rawRequest as unknown as Record<string, unknown>,
    protocol
  );
}
