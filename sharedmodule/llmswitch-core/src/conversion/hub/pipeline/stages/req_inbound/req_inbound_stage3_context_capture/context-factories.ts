import type { ContextCaptureOptions, ContextCaptureHandler } from './index.js';
import { runReqInboundStage3ContextCapture } from './index.js';
import { normalizeContextCaptureLabelWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type ContextSnapshot = Record<string, unknown> | undefined;
export type ContextCaptureFn = (options: ContextCaptureOptions) => Promise<ContextSnapshot> | ContextSnapshot;

export function createResponsesContextCapture(
  captureImpl: ContextCaptureHandler
): ContextCaptureFn {
  return (options: ContextCaptureOptions) =>
    runReqInboundStage3ContextCapture({
      rawRequest: options.rawRequest,
      adapterContext: options.adapterContext,
      stageRecorder: options.stageRecorder,
      captureContext: captureImpl
    });
}

export function createNoopContextCapture(label: string): ContextCaptureFn {
  const normalizedLabel = normalizeContextCaptureLabelWithNative(label);
  return (options: ContextCaptureOptions) =>
    runReqInboundStage3ContextCapture({
      rawRequest: options.rawRequest,
      adapterContext: options.adapterContext,
      stageRecorder: options.stageRecorder,
      captureContext: () => ({ stage: normalizedLabel })
    });
}
