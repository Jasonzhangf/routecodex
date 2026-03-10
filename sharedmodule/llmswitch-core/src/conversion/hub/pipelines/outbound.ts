import type { ChatEnvelope, AdapterContext } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { FormatAdapter, SemanticMapper, StageRecorder } from '../format-adapters/index.js';
import type { JsonObject } from '../types/json.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type OutboundStage = 'semantic_map_from_chat' | 'format_build' | 'outbound_passthrough';

export interface OutboundPassthroughConfig {
  mode: 'protocol';
  factory: (chat: ChatEnvelope, ctx: AdapterContext) => Promise<JsonObject> | JsonObject;
}

export interface OutboundPlan {
  protocol?: string;
  stages: OutboundStage[];
  formatAdapter?: Pick<FormatAdapter, 'buildResponse'>;
  semanticMapper?: Pick<SemanticMapper, 'fromChat'>;
  passthrough?: OutboundPassthroughConfig;
}

export interface OutboundPipelineOptions {
  chat: ChatEnvelope;
  context: AdapterContext;
  plan: OutboundPlan;
  stageRecorder?: StageRecorder;
}

function recordStage(recorder: StageRecorder | undefined, stage: OutboundStage, payload: object): void {
  if (!recorder) return;
  try {
    recorder.record(stage, payload);
  } catch {
    /* ignore recorder errors */
  }
}

export async function runOutboundPipeline(options: OutboundPipelineOptions): Promise<JsonObject> {
  const { chat, context, plan, stageRecorder } = options;
  if (!plan) throw new Error('Outbound plan is required');
  normalizeProviderProtocolTokenWithNative(plan.protocol || context.providerProtocol);

  if (plan.passthrough?.mode === 'protocol') {
    if (!plan.passthrough.factory) {
      throw new Error('Outbound passthrough requires factory');
    }
    const payload = await plan.passthrough.factory(chat, context);
    recordStage(stageRecorder, 'outbound_passthrough', payload);
    return payload;
  }

  if (!Array.isArray(plan.stages) || plan.stages.length === 0) {
    throw new Error('Outbound plan must declare stages or passthrough');
  }

  let formatEnvelope: FormatEnvelope | undefined;
  let finalPayload: JsonObject | undefined;

  for (const stage of plan.stages) {
    switch (stage) {
      case 'semantic_map_from_chat': {
        if (!plan.semanticMapper) {
          throw new Error('semantic_map_from_chat stage requires semantic mapper');
        }
        formatEnvelope = await plan.semanticMapper.fromChat(chat, context);
        recordStage(stageRecorder, 'semantic_map_from_chat', formatEnvelope);
        break;
      }
      case 'format_build': {
        if (!plan.formatAdapter) {
          throw new Error('format_build stage requires format adapter');
        }
        if (!formatEnvelope) {
          throw new Error('format_build stage requires semantic_map_from_chat result');
        }
        finalPayload = await plan.formatAdapter.buildResponse(formatEnvelope, context) as JsonObject;
        recordStage(stageRecorder, 'format_build', finalPayload);
        break;
      }
      default:
        throw new Error(`Unknown outbound stage: ${stage as string}`);
    }
  }

  if (finalPayload === undefined) {
    throw new Error('Outbound pipeline did not produce payload');
  }
  return finalPayload;
}
