import type { VirtualRouterClockConfig } from '../../../router/virtual-router/types.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import { logClock } from '../../../servertool/clock/log.js';
import type { HubOperation } from '../ops/operations.js';
import {
  buildClockStandardToolAppendOperations,
  buildClockToolAppendOperations
} from './chat-process-clock-tool-schemas.js';
import { planChatClockOperationsWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { isClientInjectReady } from './client-inject-readiness.js';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildClockOperations(metadata: Record<string, unknown>): HubOperation[] {
  if (!isClientInjectReady(metadata)) {
    return [];
  }
  const rt = (readRuntimeMetadata(metadata) ?? {}) as Record<string, unknown>;
  const rawConfig = (rt as any)?.clock as VirtualRouterClockConfig | undefined;
  const plan = planChatClockOperationsWithNative(rt as Record<string, unknown>);
  if (!plan.shouldInject) {
    return [];
  }

  const sessionId = readString(metadata.sessionId);
  const hasSessionId = Boolean(sessionId && sessionId.trim());
  logClock('inject_schema', { hasSessionId });
  return buildClockToolAppendOperations(hasSessionId);
}

export function buildClockOperationsWithPlan(
  metadata: Record<string, unknown>,
  precomputedPlan?: { shouldInject: boolean }
): HubOperation[] {
  if (!isClientInjectReady(metadata)) {
    return [];
  }
  if (!precomputedPlan) {
    return buildClockOperations(metadata);
  }
  if (!precomputedPlan.shouldInject) {
    return [];
  }
  const sessionId = readString(metadata.sessionId);
  const hasSessionId = Boolean(sessionId && sessionId.trim());
  logClock('inject_schema', { hasSessionId });
  return buildClockToolAppendOperations(hasSessionId);
}

export function buildClockStandardToolsOperations(): HubOperation[] {
  return buildClockStandardToolAppendOperations();
}
