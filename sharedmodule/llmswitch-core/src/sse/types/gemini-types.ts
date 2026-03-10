import type { BaseSseEvent, StreamDirection } from './core-interfaces.js';
import type { ChatReasoningMode } from './chat-types.js';

export interface GeminiContentTextPart {
  text: string;
}

export interface GeminiContentFunctionCallPart {
  functionCall: {
    name: string;
    args?: Record<string, unknown>;
    id?: string;
    [key: string]: unknown;
  };
}

export interface GeminiContentFunctionResponsePart {
  functionResponse: {
    name?: string;
    id?: string;
    response?: unknown;
    [key: string]: unknown;
  };
}

export interface GeminiContentInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiContentThoughtPart {
  thought: string;
}

export interface GeminiContentExecutableCodePart {
  executableCode: {
    language?: string;
    code?: string;
    [key: string]: unknown;
  };
}

export interface GeminiContentCodeExecutionResultPart {
  codeExecutionResult: {
    outcome?: string;
    output?: string;
    [key: string]: unknown;
  };
}

export type GeminiContentPart =
  | GeminiContentTextPart
  | GeminiContentFunctionCallPart
  | GeminiContentFunctionResponsePart
  | GeminiContentInlineDataPart
  | GeminiContentThoughtPart
  | GeminiContentExecutableCodePart
  | GeminiContentCodeExecutionResultPart
  | Record<string, unknown>;

export interface GeminiCandidate {
  content?: {
    role?: string;
    parts?: GeminiContentPart[];
  };
  finishReason?: string;
  safetyRatings?: unknown[];
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: Record<string, unknown>;
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

export interface GeminiEventStats {
  totalEvents: number;
  chunkEvents: number;
  doneEvents: number;
  errors: number;
  startTime: number;
  endTime?: number;
}

export interface GeminiJsonToSseOptions {
  requestId: string;
  model?: string;
  chunkDelayMs?: number;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

export interface GeminiJsonToSseContext {
  requestId: string;
  model?: string;
  response: GeminiResponse;
  options: GeminiJsonToSseOptions;
  startTime: number;
  eventStats: GeminiEventStats;
}

export interface SseToGeminiJsonOptions {
  requestId: string;
  model?: string;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

export interface SseToGeminiJsonContext {
  requestId: string;
  model?: string;
  options: {
    reasoningMode?: ChatReasoningMode;
    reasoningTextPrefix?: string;
  };
  startTime: number;
  eventStats: GeminiEventStats;
  isCompleted: boolean;
}

export type GeminiSseEventType = 'gemini.data' | 'gemini.done' | 'gemini.error';

export interface GeminiSseEvent extends BaseSseEvent {
  type: GeminiSseEventType;
  event?: GeminiSseEventType;
  protocol: 'gemini-chat';
  direction: StreamDirection;
  data: unknown;
}

export interface GeminiChunkEventData {
  kind: 'part';
  candidateIndex: number;
  partIndex: number;
  role: string;
  part: GeminiContentPart;
}

export interface GeminiDoneEventData {
  kind: 'done';
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: Record<string, unknown>;
  modelVersion?: string;
  candidates?: Array<{ index: number; finishReason?: string; safetyRatings?: unknown[] }>;
}

export const DEFAULT_GEMINI_CONVERSION_CONFIG = {
  chunkDelayMs: 0,
  reasoningMode: 'channel' as ChatReasoningMode,
  reasoningTextPrefix: undefined as string | undefined
};
