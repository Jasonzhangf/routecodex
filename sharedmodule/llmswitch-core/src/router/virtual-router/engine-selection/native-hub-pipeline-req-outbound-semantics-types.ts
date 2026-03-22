import type { JsonObject } from '../../../conversion/hub/types/json.js';

export interface NativeReqOutboundContextMergePlanInput {
  snapshot?: Record<string, unknown>;
  existingToolOutputs?: unknown[];
  hasExistingTools: boolean;
}

export interface NativeReqOutboundFormatBuildInput {
  formatEnvelope: Record<string, unknown>;
  protocol: string;
}

export interface NativeReqOutboundContextMergePlan {
  mergedToolOutputs?: Array<{ tool_call_id: string; content: string; name?: string }>;
  normalizedTools?: unknown[];
}

export interface NativeReqOutboundContextSnapshotPatchInput {
  chatEnvelope: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

export interface NativeReqOutboundContextSnapshotPatch {
  toolOutputs?: Array<{ tool_call_id: string; content: string; name?: string }>;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: unknown;
      strict?: boolean;
    };
  }>;
}

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

export interface NativeToolSessionCompatInput {
  messages: unknown[];
  toolOutputs?: unknown[];
}

export interface NativeToolSessionCompatOutput {
  messages: unknown[];
  toolOutputs?: unknown[];
}

export interface NativeToolSessionHistoryUpdateInput {
  messages: unknown[];
  existingHistory?: {
    lastMessages: Array<{
      role: string;
      toolUse?: { id: string; name?: string };
      toolResult?: { id: string; name?: string; status: string };
      ts: string;
    }>;
    pendingToolUses: Record<string, { name?: string; ts: string }>;
    updatedAt: string;
  };
  maxMessages?: number;
  nowIso?: string;
}

export interface NativeToolSessionHistoryUpdateOutput {
  history?: {
    lastMessages: Array<{
      role: string;
      toolUse?: { id: string; name?: string };
      toolResult?: { id: string; name?: string; status: string };
      ts: string;
    }>;
    pendingToolUses: Record<string, { name?: string; ts: string }>;
    updatedAt: string;
  };
  recordsCount: number;
}
