import type { StandardizedRequest } from '../types/standardized.js';
import { stripGenericMarkersFromRequest } from './chat-process-generic-marker-strip.js';

export function sanitizeChatProcessRequest(
  request: StandardizedRequest
): StandardizedRequest {
  return stripGenericMarkersFromRequest(request);
}
