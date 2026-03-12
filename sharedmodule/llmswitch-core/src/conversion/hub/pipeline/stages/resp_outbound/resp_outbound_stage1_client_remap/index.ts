import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import type { AdapterContext } from '../../../../types/chat-envelope.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import {
  buildClientPayloadForProtocol,
  type ClientProtocol
} from './client-remap-protocol-switch.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export interface RespOutboundStage1ClientRemapOptions {
  payload: JsonObject;
  clientProtocol: ClientProtocol;
  requestId: string;
  adapterContext?: AdapterContext;
  requestSemantics?: JsonObject;
  stageRecorder?: StageRecorder;
}

export function runRespOutboundStage1ClientRemap(
  options: RespOutboundStage1ClientRemapOptions
): JsonObject {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const normalizedProtocol = normalizeProviderProtocolTokenWithNative(options.clientProtocol);
  const clientProtocol: ClientProtocol =
    normalizedProtocol === 'openai-chat' ||
    normalizedProtocol === 'openai-responses' ||
    normalizedProtocol === 'anthropic-messages'
      ? normalizedProtocol
      : options.clientProtocol;
  logHubStageTiming(options.requestId, 'resp_outbound.stage1_build_client_payload', 'start', {
    clientProtocol
  });
  const buildStart = Date.now();
  const clientPayload = buildClientPayloadForProtocol({
    payload: options.payload,
    clientProtocol,
    requestId: options.requestId,
    requestSemantics: options.requestSemantics
  });
  logHubStageTiming(options.requestId, 'resp_outbound.stage1_build_client_payload', 'completed', {
    elapsedMs: Date.now() - buildStart,
    clientProtocol,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', clientPayload);
  return clientPayload;
}
