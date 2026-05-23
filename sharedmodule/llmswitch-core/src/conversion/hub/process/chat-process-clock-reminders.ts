import type { StandardizedRequest } from '../types/standardized.js';
import { applyChatProcessClockRuntimeBridge } from './blocks/chat-process-clock-runtime-bridge.js';

export async function maybeInjectClockRemindersAndApplyDirectives(
  request: StandardizedRequest,
  metadata: Record<string, unknown>,
  requestId: string
): Promise<StandardizedRequest> {
  return applyChatProcessClockRuntimeBridge(request, metadata, requestId);
}
