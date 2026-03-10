import type { ChatEnvelope, AdapterContext } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { FormatAdapter, SemanticMapper, StageRecorder } from '../format-adapters/index.js';
import type { JsonObject } from '../types/json.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type InboundStage = 'format_parse' | 'semantic_map_to_chat' | 'inbound_passthrough';

export interface InboundPassthroughConfig {
  mode: 'chat';
  factory: (raw: JsonObject, ctx: AdapterContext) => Promise<ChatEnvelope> | ChatEnvelope;
}

export interface InboundPlan {
  protocol?: string;
  stages: InboundStage[];
  formatAdapter?: Pick<FormatAdapter, 'parseRequest'>;
  semanticMapper?: Pick<SemanticMapper, 'toChat'>;
  passthrough?: InboundPassthroughConfig;
}

export interface InboundPipelineOptions {
  rawRequest: JsonObject;
  context: AdapterContext;
  plan: InboundPlan;
  stageRecorder?: StageRecorder;
}

function recordStage(recorder: StageRecorder | undefined, stage: InboundStage, payload: object): void {
  if (!recorder) return;
  try {
    recorder.record(stage, payload);
  } catch {
    /* snapshot failures ignored */
  }
}

function ensureFormatEnvelope(
  envelope: FormatEnvelope | undefined,
  rawRequest: JsonObject,
  plan: InboundPlan,
  context: AdapterContext
): FormatEnvelope {
  if (envelope) return envelope;
  const normalizedProtocol = normalizeProviderProtocolTokenWithNative(
    plan.protocol || context.providerProtocol
  );
  return {
    protocol: normalizedProtocol ?? plan.protocol ?? context.providerProtocol,
    direction: 'request',
    payload: rawRequest
  };
}

export async function runInboundPipeline(options: InboundPipelineOptions): Promise<ChatEnvelope> {
  const { rawRequest, context, plan, stageRecorder } = options;
  if (!plan) throw new Error('Inbound plan is required');

  if (plan.passthrough?.mode === 'chat') {
    if (!plan.passthrough.factory) {
      throw new Error('Inbound passthrough requires factory');
    }
    const envelope = await plan.passthrough.factory(rawRequest, context);
    recordStage(stageRecorder, 'inbound_passthrough', envelope);
    return envelope;
  }

  if (!Array.isArray(plan.stages) || plan.stages.length === 0) {
    throw new Error('Inbound plan must declare stages or passthrough');
  }

  let lastFormat: FormatEnvelope | undefined;
  let lastChat: ChatEnvelope | undefined;

  for (const stage of plan.stages) {
    switch (stage) {
      case 'format_parse': {
        if (!plan.formatAdapter) {
          throw new Error('format_parse stage requires format adapter');
        }
        lastFormat = await plan.formatAdapter.parseRequest(rawRequest, context);
        recordStage(stageRecorder, 'format_parse', lastFormat);
        break;
      }
      case 'semantic_map_to_chat': {
        if (!plan.semanticMapper) {
          throw new Error('semantic_map_to_chat stage requires semantic mapper');
        }
        const formatEnvelope = ensureFormatEnvelope(lastFormat, rawRequest, plan, context);
        lastChat = await plan.semanticMapper.toChat(formatEnvelope, context);
        recordStage(stageRecorder, 'semantic_map_to_chat', lastChat);
        break;
      }
      default:
        throw new Error(`Unknown inbound stage: ${stage as string}`);
    }
  }

  if (!lastChat) {
    throw new Error('Inbound pipeline did not produce ChatEnvelope');
  }
  return lastChat;
}
