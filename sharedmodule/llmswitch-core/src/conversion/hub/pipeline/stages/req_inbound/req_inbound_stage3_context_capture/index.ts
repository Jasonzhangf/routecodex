import type { ResponsesRequestContext } from '../../../../../responses/responses-openai-bridge.js';
import { buildToolOutputSnapshot } from './tool-output-snapshot.js';
import {
  captureResponsesContextSnapshot as captureResponsesContextSnapshotModule,
  type ResponsesContextCaptureOptions
} from './responses-context-snapshot.js';
import {
  runReqInboundStage3ContextCaptureOrchestration
} from './context-capture-orchestration.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import type {
  ContextCaptureOptions,
  ReqInboundStage3ContextCaptureOptions
} from './context-capture-orchestration.js';

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

export function captureResponsesContextSnapshot(options: ContextCaptureOptions): ResponsesRequestContext {
  return captureResponsesContextSnapshotModule(options as ResponsesContextCaptureOptions);
}

function captureChatContextSnapshot(options: ContextCaptureOptions): Record<string, unknown> {
  const protocol = normalizeProviderProtocolTokenWithNative(options.adapterContext.providerProtocol);
  return buildToolOutputSnapshot(options.rawRequest, protocol);
}
