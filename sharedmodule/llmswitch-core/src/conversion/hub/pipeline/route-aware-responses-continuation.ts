import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';
import type { JsonObject } from '../types/json.js';

export function resolveRouteAwareResponsesContinuation(args: {
  request: StandardizedRequest | ProcessedRequest;
  rawRequest: JsonObject;
  normalizedMetadata?: Record<string, unknown>;
  requestId: string;
  entryProtocol: string;
  outboundProtocol: string;
}): StandardizedRequest | ProcessedRequest {
  void args.rawRequest;
  void args.normalizedMetadata;
  void args.requestId;
  void args.entryProtocol;
  void args.outboundProtocol;
  return args.request;
}
