import type { StandardizedRequest } from '../types/standardized.js';
import { applyChatProcessRequestSanitizerRuntimeBridge } from './blocks/chat-process-request-sanitizer-runtime-bridge.js';

export function sanitizeChatProcessRequest(
  request: StandardizedRequest
): StandardizedRequest {
  return applyChatProcessRequestSanitizerRuntimeBridge(request);
}
