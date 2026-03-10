import { ChatFormatAdapter } from './format-adapters/chat-format-adapter.js';
import { AnthropicFormatAdapter } from './format-adapters/anthropic-format-adapter.js';
import { ResponsesFormatAdapter } from './format-adapters/responses-format-adapter.js';
import { ChatSemanticMapper } from './semantic-mappers/chat-mapper.js';
import { AnthropicSemanticMapper } from './semantic-mappers/anthropic-mapper.js';
import { ResponsesSemanticMapper } from './semantic-mappers/responses-mapper.js';
import { GeminiSemanticMapper } from './semantic-mappers/gemini-mapper.js';
import { GeminiFormatAdapter } from './format-adapters/gemini-format-adapter.js';
import type { InboundPlan, InboundPassthroughConfig, InboundStage } from './pipelines/inbound.js';
import type { OutboundPlan, OutboundPassthroughConfig, OutboundStage } from './pipelines/outbound.js';
import type { FormatAdapter, SemanticMapper } from './format-adapters/index.js';
import { normalizeProviderProtocolTokenWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

interface InboundPlanFactory {
  protocol: string;
  stages: InboundStage[];
  passthrough?: InboundPassthroughConfig;
  createFormatAdapter?: () => FormatAdapter;
  createSemanticMapper?: () => SemanticMapper;
}

interface OutboundPlanFactory {
  protocol: string;
  stages: OutboundStage[];
  passthrough?: OutboundPassthroughConfig;
  createFormatAdapter?: () => FormatAdapter;
  createSemanticMapper?: () => SemanticMapper;
}

export interface HubProtocolDefinition {
  protocol: string;
  inbound: InboundPlanFactory;
  outbound: OutboundPlanFactory;
}

export const HUB_PROTOCOL_REGISTRY: Record<string, HubProtocolDefinition> = {
  'openai-chat': {
    protocol: 'openai-chat',
    inbound: {
      protocol: 'openai-chat',
      stages: ['format_parse', 'semantic_map_to_chat'],
      createFormatAdapter: () => new ChatFormatAdapter(),
      createSemanticMapper: () => new ChatSemanticMapper()
    },
    outbound: {
      protocol: 'openai-chat',
      stages: ['semantic_map_from_chat', 'format_build'],
      createFormatAdapter: () => new ChatFormatAdapter(),
      createSemanticMapper: () => new ChatSemanticMapper()
    }
  },
  'anthropic-messages': {
    protocol: 'anthropic-messages',
    inbound: {
      protocol: 'anthropic-messages',
      stages: ['format_parse', 'semantic_map_to_chat'],
      createFormatAdapter: () => new AnthropicFormatAdapter(),
      createSemanticMapper: () => new AnthropicSemanticMapper()
    },
    outbound: {
      protocol: 'anthropic-messages',
      stages: ['semantic_map_from_chat', 'format_build'],
      createFormatAdapter: () => new AnthropicFormatAdapter(),
      createSemanticMapper: () => new AnthropicSemanticMapper()
    }
  },
  'openai-responses': {
    protocol: 'openai-responses',
    inbound: {
      protocol: 'openai-responses',
      stages: ['format_parse', 'semantic_map_to_chat'],
      createFormatAdapter: () => new ResponsesFormatAdapter(),
      createSemanticMapper: () => new ResponsesSemanticMapper()
    },
    outbound: {
      protocol: 'openai-responses',
      stages: ['semantic_map_from_chat', 'format_build'],
      createFormatAdapter: () => new ResponsesFormatAdapter(),
      createSemanticMapper: () => new ResponsesSemanticMapper()
  }
  },
  'gemini-chat': {
    protocol: 'gemini-chat',
    inbound: {
      protocol: 'gemini-chat',
      stages: ['format_parse', 'semantic_map_to_chat'],
      createFormatAdapter: () => new GeminiFormatAdapter(),
      createSemanticMapper: () => new GeminiSemanticMapper()
    },
    outbound: {
      protocol: 'gemini-chat',
      stages: ['semantic_map_from_chat', 'format_build'],
      createFormatAdapter: () => new GeminiFormatAdapter(),
      createSemanticMapper: () => new GeminiSemanticMapper()
    }
  }
};

function instantiateInbound(factory: InboundPlanFactory): InboundPlan {
  return {
    protocol: factory.protocol,
    stages: factory.stages,
    passthrough: factory.passthrough,
    formatAdapter: factory.createFormatAdapter?.(),
    semanticMapper: factory.createSemanticMapper?.()
  };
}

function instantiateOutbound(factory: OutboundPlanFactory): OutboundPlan {
  return {
    protocol: factory.protocol,
    stages: factory.stages,
    passthrough: factory.passthrough,
    formatAdapter: factory.createFormatAdapter?.(),
    semanticMapper: factory.createSemanticMapper?.()
  };
}

export function createProtocolPlans(protocol: string): { inbound: InboundPlan; outbound: OutboundPlan } {
  const normalizedProtocol = normalizeProviderProtocolTokenWithNative(protocol);
  const protocolKey = normalizedProtocol ?? protocol;
  const definition = HUB_PROTOCOL_REGISTRY[protocolKey];
  if (!definition) {
    throw new Error(`Unknown hub protocol: ${protocolKey}`);
  }
  return {
    inbound: instantiateInbound(definition.inbound),
    outbound: instantiateOutbound(definition.outbound)
  };
}
