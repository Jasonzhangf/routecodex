// feature_id: hub.chat_envelope_type_surface

import type { JsonObject, JsonValue } from './json.js';

export interface ChatMessageContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatToolDefinition {
  type: 'function' | string;
  name?: string;
  description?: string;
  defer_loading?: boolean;
  tools?: Array<{
    type?: 'function' | string;
    name?: string;
    description?: string;
    parameters?: JsonValue;
    strict?: boolean;
    defer_loading?: boolean;
  }>;
  function?: {
    name: string;
    description?: string;
    parameters?: JsonValue;
    strict?: boolean;
  };
  [key: string]: unknown;
}

export interface AdapterContext {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  providerId?: string;
  providerKey?: string;
  targetProviderKey?: string;
  routeId?: string;
  profileId?: string;
  streamingHint?: 'auto' | 'force' | 'disable';
  originalModelId?: string;
  clientModelId?: string;
  toolCallIdStyle?: 'fc' | 'preserve';
  responsesResume?: JsonObject;
  [key: string]: unknown;
}

export interface ChatContinuationSemantics extends JsonObject {
  chainId?: string;
  previousTurnId?: string;
  resumeFrom?: JsonObject & {
    protocol?: string;
    requestId?: string;
    responseId?: string;
    previousResponseId?: string;
    turnId?: string;
  };
  continuationScope?: 'request_chain' | 'session' | 'conversation' | 'request';
  stateOrigin?:
    | 'openai-responses'
    | 'openai-chat'
    | 'anthropic-messages'
    | 'gemini-chat'
    | 'servertool-followup'
    | 'tool-loop'
    | 'unknown'
    | string;
  restored?: boolean;
  toolContinuation?: JsonObject & {
    mode?:
      | 'required_action'
      | 'submit_tool_outputs'
      | 'tool_calls'
      | 'tool_outputs'
      | 'servertool_followup';
    pendingToolCallIds?: string[];
    submittedToolCallIds?: string[];
    resumeOutputs?: JsonValue[];
  };
  protocolHints?: JsonObject;
}

export interface ChatSemantics extends JsonObject {
  continuation?: ChatContinuationSemantics;
  session?: JsonObject;
  system?: JsonObject;
  tools?: JsonObject & {
    explicitEmpty?: boolean;
    clientToolsRaw?: JsonValue[];
    toolNameAliasMap?: JsonObject;
    toolAliasMap?: JsonObject;
  };
  responses?: JsonObject & {
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
  };
  anthropic?: JsonObject & {
    systemBlocks?: JsonValue[];
    toolNameAliasMap?: JsonObject;
    clientToolsRaw?: JsonValue[];
    messageContentShape?: JsonValue;
    providerMetadata?: JsonObject;
  };
  gemini?: JsonObject & {
    systemInstruction?: JsonValue;
    safetySettings?: JsonValue;
    generationConfig?: JsonObject;
    toolConfig?: JsonObject;
    providerMetadata?: JsonObject;
  };
  audit?: JsonObject & {
    protocolMapping?: {
      preserved?: Array<JsonObject & {
        field: string;
        disposition: 'preserved' | 'lossy' | 'dropped' | 'unsupported';
        reason: string;
        sourceProtocol?: string;
        targetProtocol?: string;
        source?: string;
      }>;
      lossy?: Array<JsonObject & {
        field: string;
        disposition: 'preserved' | 'lossy' | 'dropped' | 'unsupported';
        reason: string;
        sourceProtocol?: string;
        targetProtocol?: string;
        source?: string;
      }>;
      dropped?: Array<JsonObject & {
        field: string;
        disposition: 'preserved' | 'lossy' | 'dropped' | 'unsupported';
        reason: string;
        sourceProtocol?: string;
        targetProtocol?: string;
        source?: string;
      }>;
      unsupported?: Array<JsonObject & {
        field: string;
        disposition: 'preserved' | 'lossy' | 'dropped' | 'unsupported';
        reason: string;
        sourceProtocol?: string;
        targetProtocol?: string;
        source?: string;
      }>;
    };
  };
  providerExtras?: JsonObject;
}

export interface ChatEnvelope {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | ChatMessageContentPart[] | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
      [key: string]: unknown;
    }>;
    name?: string;
    [key: string]: unknown;
  }>;
  tools?: ChatToolDefinition[];
  toolOutputs?: Array<{
    tool_call_id: string;
    content: string;
    name?: string;
    [key: string]: unknown;
  }>;
  parameters?: JsonObject;
  semantics?: ChatSemantics;
  metadata: {
    context: AdapterContext;
    missingFields?: Array<JsonObject & {
      path: string;
      reason: string;
      originalValue?: JsonValue;
    }>;
    [key: string]: unknown;
  };
}
