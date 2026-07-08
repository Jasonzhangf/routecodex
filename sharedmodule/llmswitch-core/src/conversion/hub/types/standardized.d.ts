import type { ChatMessageContentPart, ChatSemantics } from './chat-envelope.js';
import type { JsonObject } from './json.js';

export interface StandardizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatMessageContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface StandardizedRequest {
  model: string;
  messages: StandardizedMessage[];
  tools?: Array<{
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
  }>;
  parameters: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stop?: string | string[];
    stream?: boolean;
    [key: string]: unknown;
  };
  metadata: {
    originalEndpoint: string;
    capturedContext?: Record<string, unknown>;
    requestId?: string;
    stream?: boolean;
    toolChoice?:
      | 'none'
      | 'auto'
      | 'required'
      | { type: 'function'; function: { name: string } }
      | Record<string, unknown>;
    providerKey?: string;
    providerType?: string;
    processMode?: 'chat';
    routeHint?: string;
    webSearchEnabled?: boolean;
    [key: string]: unknown;
  };
  semantics?: ChatSemantics;
}

export interface ProcessedRequest extends StandardizedRequest {
  processed: {
    timestamp: number;
    appliedRules: string[];
    status: 'success' | 'partial' | 'failed';
  };
  processingMetadata: {
    toolCalls?: Array<{
      tool_call_id: string;
      status: 'success' | 'error' | 'timeout' | 'pending';
      result?: JsonObject | JsonObject[] | string | number | boolean | null;
      error?: string;
      executionTime?: number;
    }>;
    heartbeatDirective?: {
      action: 'on' | 'off';
      intervalMs?: number;
      tmuxSessionId?: string;
      workdir?: string;
      contentChanged?: boolean;
    };
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
