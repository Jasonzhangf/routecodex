import type { JsonObject, JsonValue } from '../../types/json.js';
import type { ResponsesToolOutputEntry } from './responses-submit-tool-outputs.js';

export interface ResponsesPayload extends JsonObject {
  input?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: ResponsesToolOutputEntry[];
  stream?: JsonValue;
}
