import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import { recordStage } from '../../../stages/utils.js';
import {
  augmentReqInboundContextSnapshotWithNative,
  buildReqInboundToolOutputSnapshotWithNative,
  resolveReqInboundServerToolFollowupSnapshotWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

const CONTEXT_CAPTURE_STAGE_ID = 'chat_process.req.stage3.context_capture';

export interface ContextCaptureOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}

export type ContextCaptureHandler = (
  options: ContextCaptureOptions
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

export interface ReqInboundStage3ContextCaptureOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
  captureContext?: ContextCaptureHandler;
  stageRecorder?: StageRecorder;
}

export async function runReqInboundStage3ContextCaptureOrchestration(
  options: ReqInboundStage3ContextCaptureOptions
): Promise<Record<string, unknown> | undefined> {
  const followupSnapshot = resolveReqInboundServerToolFollowupSnapshotWithNative(options.adapterContext);
  if (followupSnapshot) {
    recordStage(options.stageRecorder, CONTEXT_CAPTURE_STAGE_ID, followupSnapshot);
    return followupSnapshot;
  }

  let context: Record<string, unknown> | undefined;
  if (options.captureContext) {
    try {
      context = await options.captureContext({
        rawRequest: options.rawRequest,
        adapterContext: options.adapterContext
      });
    } catch (error) {
      // Context capture failure must not block the inbound stage
      console.warn('[hub-pipeline] context capture failed (non-blocking):', error instanceof Error ? error.message : String(error));
      context = undefined;
    }
  }

  const baseSnapshot = buildReqInboundToolOutputSnapshotWithNative(
    options.rawRequest as unknown as Record<string, unknown>,
    options.adapterContext.providerProtocol
  );
  const snapshot = context
    ? augmentReqInboundContextSnapshotWithNative(context, baseSnapshot)
    : baseSnapshot;
  recordStage(options.stageRecorder, CONTEXT_CAPTURE_STAGE_ID, snapshot);
  return snapshot;
}
