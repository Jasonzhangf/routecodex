import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { hasStopMessageAutoCliResultInRequestWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export function hasStopMessageAutoCliResultInRequest(args: {
  adapterContext: AdapterContext;
  runtimeMetadata?: JsonObject;
}): boolean {
  return hasStopMessageAutoCliResultInRequestWithNative(args);
}
