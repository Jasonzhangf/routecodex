import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  inspectStopGatewaySignalWithNative,
  normalizeStopGatewayContextWithNative,
  type StopGatewayContext
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export function inspectStopGatewaySignal(base: unknown): StopGatewayContext {
  return inspectStopGatewaySignalWithNative(base);
}

export function attachStopGatewayContext(adapterContext: AdapterContext, context: StopGatewayContext): void {
  const rt = ensureRuntimeMetadata(adapterContext as unknown as Record<string, unknown>);
  rt.stopGatewayContext = {
    observed: context.observed,
    eligible: context.eligible,
    source: context.source,
    reason: context.reason,
    ...(typeof context.choiceIndex === 'number' ? { choiceIndex: context.choiceIndex } : {}),
    ...(typeof context.hasToolCalls === 'boolean' ? { hasToolCalls: context.hasToolCalls } : {})
  };
}

export function readStopGatewayContext(adapterContext: unknown): StopGatewayContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const rt = readRuntimeMetadata(adapterContext as Record<string, unknown>);
  const raw = rt && typeof rt === 'object' ? (rt as Record<string, unknown>).stopGatewayContext : undefined;
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
