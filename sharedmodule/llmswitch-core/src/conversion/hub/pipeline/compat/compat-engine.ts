import type { JsonObject } from '../../types/json.js';
import type { AdapterContext } from '../../types/chat-envelope.js';
import type { CompatApplicationResult } from './compat-types.js';
import {
  runRequestCompatPipeline,
  runResponseCompatPipeline
} from './compat-pipeline-executor.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

function assertCompatNativeBoundary(): void {
  normalizeProviderProtocolTokenWithNative('openai-responses');
}

export function applyRequestCompat(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext }
): CompatApplicationResult {
  assertCompatNativeBoundary();
  return runRequestCompatPipeline(profileId, payload, options);
}

export function applyResponseCompat(
  profileId: string | undefined,
  payload: JsonObject,
  options?: { adapterContext?: AdapterContext }
): CompatApplicationResult {
  assertCompatNativeBoundary();
  return runResponseCompatPipeline(profileId, payload, options);
}
