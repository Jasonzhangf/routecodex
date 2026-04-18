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

export interface ChatSemantics extends JsonObject {
  continuation?: ChatContinuationSemantics;
  session?: JsonObject;
  system?: JsonObject;
  tools?: JsonObject;
  responses?: JsonObject;
  anthropic?: JsonObject;
  gemini?: JsonObject;
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
