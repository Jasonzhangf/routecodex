import type { JsonObject } from '../../../conversion/hub/types/json.js';
import { buildServertoolGenericFollowupPayloadWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { buildServertoolFollowupConfig } from '../../skeleton-config.js';
import type { ServerToolFollowupInjectionPlan } from '../../types.js';
import { resolveFollowupInjectionOpsForNative } from './op-blocks.js';
import {
  extractCapturedChatSeed,
  resolveFollowupModel,
  sanitizeFollowupParametersForResolvedModel
} from './seed.js';
import { isTextualToolTransportOnlyAssistantMessage } from './message-blocks.js';

export function isNativeSupportedFollowupInjectionPlan(injection: ServerToolFollowupInjectionPlan): boolean {
  const injectionOps = Array.isArray(injection?.ops) ? (injection.ops as Array<Record<string, unknown>>) : [];
  const followupConfig = buildServertoolFollowupConfig();
  const nativeSupportedOps = new Set(followupConfig.nativeSupportedOps);
  return injectionOps.every((op) => {
    const opName = typeof op?.op === 'string' ? String(op.op).trim() : '';
    return nativeSupportedOps.has(opName);
  });
}

export function buildNativeFollowupPayloadFromInjection(args: {
  adapterContext: unknown;
  chatResponse: JsonObject;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  const captured =
    args.adapterContext && typeof args.adapterContext === 'object'
      ? ((args.adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest as unknown)
      : undefined;
  const seed = extractCapturedChatSeed(captured);
  if (!seed) {
    return null;
  }
  const followupModel = resolveFollowupModel(seed.model, args.adapterContext);
  if (!followupModel) {
    return null;
  }
  const choices = Array.isArray((args.chatResponse as any)?.choices)
    ? ((args.chatResponse as any).choices as Array<Record<string, unknown>>)
    : [];
  const firstMessage =
    choices[0]?.message && typeof choices[0].message === 'object' && !Array.isArray(choices[0].message)
      ? (choices[0].message as Record<string, unknown>)
      : undefined;
  const assistantMessage =
    firstMessage && !isTextualToolTransportOnlyAssistantMessage(firstMessage)
      ? firstMessage
      : undefined;
  const toolOutputs = Array.isArray((args.chatResponse as any)?.tool_outputs)
    ? ((args.chatResponse as any).tool_outputs as unknown[])
    : [];
  const injectionOps = Array.isArray(args.injection?.ops)
    ? (args.injection.ops as Array<Record<string, unknown>>)
    : [];

  return buildServertoolGenericFollowupPayloadWithNative({
    model: followupModel,
    messages: seed.messages,
    tools: seed.tools,
    parameters: sanitizeFollowupParametersForResolvedModel({
      parameters: seed.parameters,
      seedModel: seed.model,
      followupModel
    }),
    assistantMessage,
    toolOutputs,
    followupInjectionOps: resolveFollowupInjectionOpsForNative({
      ops: injectionOps,
      seed
    })
  }) as JsonObject;
}
