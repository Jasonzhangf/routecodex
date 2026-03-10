import type { ChatMessageContentPart, ChatSemantics } from './chat-envelope.js';
import type { JsonObject } from './json.js';

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }
  | Record<string, unknown>;

export interface StandardizedTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: {
      type?: string | string[];
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
      [key: string]: unknown;
    };
    strict?: boolean;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallResult {
  tool_call_id: string;
  status: 'success' | 'error' | 'timeout' | 'pending';
  result?: JsonObject | JsonObject[] | string | number | boolean | null;
  error?: string;
  executionTime?: number;
}

export type StandardizedMessageContent = string | ChatMessageContentPart[] | null;

export interface StandardizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: StandardizedMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface StandardizedParameters {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface StandardizedMetadata {
  originalEndpoint: string;
  capturedContext?: Record<string, unknown>;
  requestId?: string;
  stream?: boolean;
  toolChoice?: ToolChoice;
  providerKey?: string;
  providerType?: string;
  processMode?: 'chat' | 'passthrough';
  routeHint?: string;
  webSearchEnabled?: boolean;
  [key: string]: unknown;
}

export interface StandardizedRequest {
  model: string;
  messages: StandardizedMessage[];
  tools?: StandardizedTool[];
  parameters: StandardizedParameters;
  metadata: StandardizedMetadata;
  semantics?: ChatSemantics;
}

export interface ProcessedRequest extends StandardizedRequest {
  processed: {
    timestamp: number;
    appliedRules: string[];
    status: 'success' | 'partial' | 'failed';
  };
  processingMetadata: {
    toolCalls?: ToolCallResult[];
    streaming?: {
      enabled: boolean;
      chunkCount?: number;
      totalTokens?: number;
    };
    context?: {
      systemPrompt?: string;
      conversationHistory?: string[];
      relevantContext?: Record<string, unknown>;
    };
    passthrough?: boolean;
  };
}
