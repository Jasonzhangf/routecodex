import type { StandardizedRequest } from '../types/standardized.js';
import { stripMarkerSyntaxFromRequest } from '../../shared/marker-lifecycle.js';
import { parseRoutingInstructions } from '../../../router/virtual-router/routing-instructions/parse.js';

export function stripGenericMarkersFromRequest(
  request: StandardizedRequest
): StandardizedRequest {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length > 0) {
    const hasRoutingInstructionMarkers = parseRoutingInstructions(messages).length > 0;
    if (hasRoutingInstructionMarkers) {
      // Keep routing markers (e.g. <**sm:30**>) until virtual-router route stage applies them.
      // route_select stage will strip marker syntax before forwarding upstream.
      return request;
    }
  }
  return stripMarkerSyntaxFromRequest(request);
}
