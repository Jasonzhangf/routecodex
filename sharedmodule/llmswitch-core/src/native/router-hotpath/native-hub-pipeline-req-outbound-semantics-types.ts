import type { JsonObject } from '../../conversion/hub/types/json.js';

export interface NativeReqOutboundCompatAdapterContextInput {
  __rt?: Record<string, unknown>;
  compatibilityProfile?: string;
  providerProtocol?: string;
  providerId?: string;
  providerKey?: string;
  runtimeKey?: string;
  requestId?: string;
  clientRequestId?: string;
  groupRequestId?: string;
  sessionId?: string;
  conversationId?: string;
  entryEndpoint?: string;
  routeId?: string;
  capturedChatRequest?: JsonObject;
  deepseek?: Record<string, unknown>;
  claudeCode?: Record<string, unknown>;
  anthropicThinkingConfig?: Record<string, unknown>;
  anthropicThinking?: string;
  anthropicThinkingBudgets?: Record<string, unknown>;
  estimatedInputTokens?: number;
  modelId?: string;
  clientModelId?: string;
  originalModelId?: string;
}

export interface NativeReqOutboundStandardizedToChatInput {
  request: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
}

export interface NativeReqOutboundStage3CompatInput {
  payload: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
  explicitProfile?: string;
}

export interface NativeReqOutboundStage3CompatOutput {
  payload: JsonObject;
  appliedProfile?: string;
  nativeApplied: boolean;
  rateLimitDetected?: boolean;
}

export interface NativeRespInboundStage3CompatInput {
  payload: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
  explicitProfile?: string;
}

export type NativeRespInboundStage3CompatOutput = NativeReqOutboundStage3CompatOutput;
