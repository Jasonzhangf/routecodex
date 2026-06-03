import type { StandardizedRequest } from '../types/standardized.js';
import {
  cleanRoutingInstructionMarkersWithNative,
  parseRoutingInstructionsWithNative,
} from '../../../router/virtual-router/engine-selection/native-virtual-router-routing-instructions-semantics.js';

export function stripGenericMarkersFromRequest(
  request: StandardizedRequest
): StandardizedRequest {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length > 0) {
    const hasRoutingInstructionMarkers = parseRoutingInstructionsWithNative(
      messages as unknown as Array<Record<string, unknown>>
    ).length > 0;
    if (hasRoutingInstructionMarkers) {
      // Keep routing markers (e.g. <**sm:30**>) until virtual-router route stage applies them.
      // route_select stage will strip marker syntax before forwarding upstream.
      return request;
    }
  }
  return cleanRoutingInstructionMarkersWithNative(
    request as unknown as Record<string, unknown>
  ) as unknown as StandardizedRequest;
}
