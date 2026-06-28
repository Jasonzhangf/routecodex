import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import {
  inspectStopGatewaySignalWithNative,
  normalizeStopGatewayContextWithNative,
  type StopGatewayContext
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  readRuntimeControlFromAnyBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter
} from './metadata-center-carrier.js';

const STOP_GATEWAY_CONTEXT_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/stop-gateway-context.ts',
  symbol: 'attachStopGatewayContext',
  stage: 'HubRespChatProcess03Governed'
} as const;

export function inspectStopGatewaySignal(base: unknown): StopGatewayContext {
  return inspectStopGatewaySignalWithNative(base);
}

export function attachStopGatewayContext(adapterContext: AdapterContext, context: StopGatewayContext): void {
  writeRuntimeControlToBoundMetadataCenter({
    metadata: adapterContext as unknown as Record<string, unknown>,
    key: 'stopGatewayContext',
    value: {
      observed: context.observed,
      eligible: context.eligible,
      source: context.source,
      reason: context.reason,
      ...(typeof context.choiceIndex === 'number' ? { choiceIndex: context.choiceIndex } : {}),
      ...(typeof context.hasToolCalls === 'boolean' ? { hasToolCalls: context.hasToolCalls } : {})
    },
    writer: STOP_GATEWAY_CONTEXT_WRITER,
    reason: 'response stop gateway control signal',
    required: true
  });
}

export function readStopGatewayContext(adapterContext: unknown): StopGatewayContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(adapterContext as Record<string, unknown>);
  const raw = runtimeControl?.stopGatewayContext;
  return normalizeStopGatewayContextWithNative(raw);
}

export function resolveStopGatewayContext(base: unknown, adapterContext?: unknown): StopGatewayContext {
  const fromMetadata = readStopGatewayContext(adapterContext);
  if (fromMetadata) {
    return fromMetadata;
  }
  return inspectStopGatewaySignal(base);
}

export function isStopEligibleForServerTool(base: unknown, adapterContext?: unknown): boolean {
  return resolveStopGatewayContext(base, adapterContext).eligible;
}
