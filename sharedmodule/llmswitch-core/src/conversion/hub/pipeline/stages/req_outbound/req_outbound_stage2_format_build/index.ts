import type { FormatEnvelope } from '../../../../types/format-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import { recordStage } from '../../../stages/utils.js';
import { stripPrivateFieldsWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import { buildReqOutboundFormatPayloadWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

export interface ReqOutboundStage2FormatBuildOptions {
  formatEnvelope: FormatEnvelope<JsonObject>;
  stageRecorder?: StageRecorder;
}

export async function runReqOutboundStage2FormatBuild(
  options: ReqOutboundStage2FormatBuildOptions
): Promise<JsonObject> {
  const payload = buildReqOutboundFormatPayloadWithNative({
    formatEnvelope: options.formatEnvelope as unknown as Record<string, unknown>,
    protocol: options.formatEnvelope.protocol
  });
  const stripped = stripPrivateFieldsWithNative(payload) as JsonObject;
  recordStage(options.stageRecorder, 'chat_process.req.stage7.outbound.format_build', stripped);
  return stripped;
}
