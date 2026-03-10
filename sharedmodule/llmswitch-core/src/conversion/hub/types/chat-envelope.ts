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

export interface ChatSemantics extends JsonObject {
  session?: JsonObject;
  system?: JsonObject;
  tools?: JsonObject;
  responses?: JsonObject;
  anthropic?: JsonObject;
  gemini?: JsonObject;
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
