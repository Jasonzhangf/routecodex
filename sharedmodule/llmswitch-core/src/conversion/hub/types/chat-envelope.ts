export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

import type { JsonObject, JsonValue } from './json.js';

export interface ChatMessageContentPart {
  type: string;
  text?: string;
  [key: string]: JsonValue;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  [key: string]: JsonValue;
}

export interface ChatMessage {
  role: ChatRole;
  content?: string | ChatMessageContentPart[] | null;
  tool_calls?: ChatToolCall[];
  name?: string;
  [key: string]: JsonValue;
}

export interface ChatToolDefinition {
  type: 'function' | string;
  function: {
    name: string;
    description?: string;
    parameters?: JsonValue;
    strict?: boolean;
  };
  [key: string]: JsonValue;
}

export interface ChatToolOutput {
  tool_call_id: string;
  content: string;
  name?: string;
  [key: string]: JsonValue;
}

export interface MissingField extends JsonObject {
  path: string;
  reason: string;
  originalValue?: JsonValue;
}

export interface AdapterContext {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  providerId?: string;
  routeId?: string;
  profileId?: string;
  streamingHint?: 'auto' | 'force' | 'disable';
  originalModelId?: string;
  clientModelId?: string;
  toolCallIdStyle?: 'fc' | 'preserve';
  responsesResume?: JsonObject;
  [key: string]: JsonValue;
}

export type ChatContinuationStickyScope =
  | 'request_chain'
  | 'session'
  | 'conversation'
  | 'request';

export type ChatContinuationStateOrigin =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'gemini-chat'
  | 'servertool-followup'
  | 'tool-loop'
  | 'unknown';

export interface ChatContinuationPointer extends JsonObject {
  protocol?: string;
  requestId?: string;
  responseId?: string;
  previousResponseId?: string;
  turnId?: string;
}

export interface ChatToolContinuation extends JsonObject {
  mode?:
    | 'required_action'
    | 'submit_tool_outputs'
    | 'tool_calls'
    | 'tool_outputs'
    | 'servertool_followup';
  pendingToolCallIds?: string[];
  submittedToolCallIds?: string[];
  resumeOutputs?: JsonValue[];
}

export interface ChatContinuationSemantics extends JsonObject {
  chainId?: string;
  previousTurnId?: string;
  resumeFrom?: ChatContinuationPointer;
  stickyScope?: ChatContinuationStickyScope;
  stateOrigin?: ChatContinuationStateOrigin | string;
  restored?: boolean;
  toolContinuation?: ChatToolContinuation;
  protocolHints?: JsonObject;
}

export type ChatProtocolMappingDisposition =
  | 'preserved'
  | 'lossy'
  | 'dropped'
  | 'unsupported';

export interface ChatProtocolMappingAuditEntry extends JsonObject {
  field: string;
  disposition: ChatProtocolMappingDisposition;
  reason: string;
  sourceProtocol?: string;
  targetProtocol?: string;
  source?: string;
}

export interface ChatSemanticAudit extends JsonObject {
  protocolMapping?: {
    preserved?: ChatProtocolMappingAuditEntry[];
    lossy?: ChatProtocolMappingAuditEntry[];
    dropped?: ChatProtocolMappingAuditEntry[];
    unsupported?: ChatProtocolMappingAuditEntry[];
  };
}

export interface ChatToolSemantics extends JsonObject {
  explicitEmpty?: boolean;
  clientToolsRaw?: JsonValue[];
  toolNameAliasMap?: JsonObject;
  toolAliasMap?: JsonObject;
}

export interface ChatResponsesSemantics extends JsonObject {
  context?: JsonObject;
  resume?: JsonObject;
  requestParameters?: JsonObject;
  responseFormat?: JsonValue;
  include?: JsonValue[];
  store?: boolean;
  promptCacheKey?: string;
  toolChoice?: JsonValue;
  parallelToolCalls?: boolean;
  reasoning?: JsonValue;
  text?: JsonValue;
  serviceTier?: JsonValue;
  truncation?: JsonValue;
  modalities?: JsonValue;
}

export interface ChatAnthropicSemantics extends JsonObject {
  systemBlocks?: JsonValue[];
  toolNameAliasMap?: JsonObject;
  clientToolsRaw?: JsonValue[];
  messageContentShape?: JsonValue;
  providerMetadata?: JsonObject;
}

export interface ChatGeminiSemantics extends JsonObject {
  systemInstruction?: JsonValue;
  safetySettings?: JsonValue;
  generationConfig?: JsonObject;
  toolConfig?: JsonObject;
  providerMetadata?: JsonObject;
}

export interface ChatSemantics extends JsonObject {
  continuation?: ChatContinuationSemantics;
  session?: JsonObject;
  system?: JsonObject;
  tools?: ChatToolSemantics;
  responses?: ChatResponsesSemantics;
  anthropic?: ChatAnthropicSemantics;
  gemini?: ChatGeminiSemantics;
  audit?: ChatSemanticAudit;
  providerExtras?: JsonObject;
}

export interface ChatEnvelope {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolOutputs?: ChatToolOutput[];
  parameters?: JsonObject;
  semantics?: ChatSemantics;
  metadata: {
    context: AdapterContext;
    missingFields?: MissingField[];
    [key: string]: JsonValue;
  };
}
