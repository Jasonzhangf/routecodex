import type { StandardizedRequest } from '../types/standardized.js';
import { stripMarkerSyntaxFromRequest } from '../../shared/marker-lifecycle.js';

export function stripGenericMarkersFromRequest(
  request: StandardizedRequest
): StandardizedRequest {
  return stripMarkerSyntaxFromRequest(request);
}
