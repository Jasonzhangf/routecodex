import type { JsonObject } from './json.js';

export interface FormatEnvelope<TPayload extends JsonObject = JsonObject> {
  protocol: string;
  direction: 'request' | 'response';
  payload: TPayload;
  meta?: JsonObject;
}
