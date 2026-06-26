import type { AdapterContext } from '../../types/chat-envelope.js';
import type { JsonObject } from '../../types/json.js';
import type { NativeReqOutboundCompatAdapterContextInput } from '../../../../native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';
import { readRuntimeControlFromBoundMetadataCenter } from '../../../../servertool/stopless-metadata-carrier.js';

export function buildNativeReqOutboundCompatAdapterContext(
  adapterContext?: AdapterContext
): NativeReqOutboundCompatAdapterContextInput {
  const row = (adapterContext ?? {}) as Record<string, unknown>;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(row);

  const readString = (key: string): string | undefined => {
    const value = row[key];
    return typeof value === 'string' && value.trim().length ? value.trim() : undefined;
  };

  const readNumber = (key: string): number | undefined => {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  const readRecord = (key: string): Record<string, unknown> | undefined => {
    const value = row[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  };

  return {
    __rt: readRecord('__rt'),
    compatibilityProfile: readString('compatibilityProfile'),
    providerProtocol: (() => {
      const providerProtocol =
        typeof runtimeControl?.providerProtocol === 'string' && runtimeControl.providerProtocol.trim()
          ? runtimeControl.providerProtocol.trim()
          : undefined;
      if (!providerProtocol) {
        throw new Error('Native req outbound compat adapter context requires metadata center runtime_control.providerProtocol');
      }
      return providerProtocol;
    })(),
    providerId: readString('providerId'),
    providerKey: readString('providerKey'),
    runtimeKey: readString('runtimeKey'),
    requestId: readString('requestId') ?? adapterContext?.requestId,
    clientRequestId: readString('clientRequestId'),
    groupRequestId: readString('groupRequestId'),
    sessionId: readString('sessionId'),
    conversationId: readString('conversationId'),
    entryEndpoint: readString('entryEndpoint') ?? adapterContext?.entryEndpoint,
    routeId: readString('routeId') ?? adapterContext?.routeId,
    capturedChatRequest: readRecord('capturedChatRequest') as JsonObject | undefined,
    deepseek: readRecord('deepseek'),
    claudeCode: readRecord('claudeCode'),
    anthropicThinkingConfig: readRecord('anthropicThinkingConfig'),
    anthropicThinking: readString('anthropicThinking'),
    anthropicThinkingBudgets: readRecord('anthropicThinkingBudgets'),
    estimatedInputTokens: readNumber('estimatedInputTokens'),
    modelId: readString('modelId'),
    clientModelId: readString('clientModelId'),
    originalModelId: readString('originalModelId')
  };
}
