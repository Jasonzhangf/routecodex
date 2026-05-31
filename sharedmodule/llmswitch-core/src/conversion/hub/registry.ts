import type { InboundPlan, InboundPassthroughConfig, InboundStage } from './pipelines/inbound.js';
import type { OutboundPlan, OutboundPassthroughConfig, OutboundStage } from './pipelines/outbound.js';
import { normalizeProviderProtocolTokenWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

interface InboundPlanFactory {
  protocol: string;
  stages: InboundStage[];
  passthrough?: InboundPassthroughConfig;
}

interface OutboundPlanFactory {
  protocol: string;
  stages: OutboundStage[];
  passthrough?: OutboundPassthroughConfig;
}

export interface HubProtocolDefinition {
  protocol: string;
  inbound: InboundPlanFactory;
  outbound: OutboundPlanFactory;
}

function protocolDefinition(protocol: string): HubProtocolDefinition {
  return {
    protocol,
    inbound: {
      protocol,
      stages: ['format_parse', 'semantic_map_to_chat'],
    },
    outbound: {
      protocol,
      stages: ['semantic_map_from_chat', 'format_build'],
    },
  };
}

export const HUB_PROTOCOL_REGISTRY: Record<string, HubProtocolDefinition> = {
  'openai-chat': protocolDefinition('openai-chat'),
  'anthropic-messages': protocolDefinition('anthropic-messages'),
  'openai-responses': protocolDefinition('openai-responses'),
  'gemini-chat': protocolDefinition('gemini-chat'),
};

function instantiateInbound(factory: InboundPlanFactory): InboundPlan {
  return {
    protocol: factory.protocol,
    stages: factory.stages,
    passthrough: factory.passthrough,
  };
}

function instantiateOutbound(factory: OutboundPlanFactory): OutboundPlan {
  return {
    protocol: factory.protocol,
    stages: factory.stages,
    passthrough: factory.passthrough,
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
    outbound: instantiateOutbound(definition.outbound),
  };
}
