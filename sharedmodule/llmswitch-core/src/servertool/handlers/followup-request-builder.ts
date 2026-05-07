import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolFollowupInjectionPlan } from '../types.js';
import { buildChatFollowupPayloadFromInjection } from './followup-request-builder/chat-block.js';
import {
  buildNativeFollowupPayloadFromInjection,
  isNativeSupportedFollowupInjectionPlan
} from './followup-request-builder/native-block.js';
import {
  dropToolByFunctionName,
  extractCapturedChatSeed,
  normalizeFollowupParameters
} from './followup-request-builder/seed.js';

export type { CapturedChatSeed } from './followup-request-builder/seed.js';
export { dropToolByFunctionName, extractCapturedChatSeed, normalizeFollowupParameters };

export function buildServerToolFollowupPayloadFromInjection(args: {
  adapterContext: unknown;
  chatResponse: JsonObject;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  if (!isNativeSupportedFollowupInjectionPlan(args.injection)) {
    return buildChatFollowupPayloadFromInjection(args);
  }
  return buildNativeFollowupPayloadFromInjection(args);
}

export function buildServerToolFollowupChatPayloadFromInjection(args: {
  adapterContext: unknown;
  chatResponse: JsonObject;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  return buildChatFollowupPayloadFromInjection(args);
}
