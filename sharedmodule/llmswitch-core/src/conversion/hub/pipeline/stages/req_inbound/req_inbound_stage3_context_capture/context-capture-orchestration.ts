import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import { recordStage } from '../../../stages/utils.js';
import {
  augmentReqInboundContextSnapshotWithNative,
  buildReqInboundToolOutputSnapshotWithNative,
  resolveReqInboundServerToolFollowupSnapshotWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { saveOriginSnapshot } from '../../../../../../servertool/origin-request-store.js';
import { resolveServertoolPersistentScopeKey } from '../../../../../../servertool/state-scope.js';

const CONTEXT_CAPTURE_STAGE_ID = 'chat_process.req.stage3.context_capture';

function saveReqInboundOriginSnapshot(options: ReqInboundStage3ContextCaptureOptions): void {
  const scope = resolveServertoolPersistentScopeKey(options.adapterContext);
  if (!scope) {
    return;
  }
  const rawRequest = options.rawRequest as Record<string, unknown>;
  saveOriginSnapshot(scope, {
    requestId: options.adapterContext.requestId ?? String(Date.now()),
    sessionScope: scope,
    capturedChatRequest: rawRequest as JsonObject,
    model: typeof rawRequest.model === 'string' ? rawRequest.model : undefined,
    messages: (Array.isArray(rawRequest.messages) ? rawRequest.messages : []) as JsonObject[],
    tools: (Array.isArray(rawRequest.tools) ? rawRequest.tools : []) as JsonObject[],
    parameters: rawRequest.parameters && typeof rawRequest.parameters === 'object' && !Array.isArray(rawRequest.parameters)
      ? (rawRequest.parameters as JsonObject)
      : undefined,
    entryEndpoint: options.adapterContext.entryEndpoint,
    providerProtocol: options.adapterContext.providerProtocol
  });
}

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
  saveReqInboundOriginSnapshot(options);
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
