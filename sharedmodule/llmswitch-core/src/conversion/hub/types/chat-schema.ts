import type { JsonObject, JsonValue } from './json.js';

export type ChatHubVersion = 'chat-hub@1';

export interface ConversationReference {
  readonly id?: string;
  readonly parentIds?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface InstructionSegment {
  readonly id?: string;
  readonly source: string;
  readonly content: string;
  readonly metadata?: JsonObject;
}

export interface InstructionsEnvelope {
  readonly segments: readonly InstructionSegment[];
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface BaseContentBlock {
  readonly type: string;
  readonly metadata?: JsonObject;
}

export interface TextContentBlock extends BaseContentBlock {
  readonly type: 'text';
  readonly text: string;
  readonly annotations?: readonly JsonObject[];
}

export interface ImageContentBlock extends BaseContentBlock {
  readonly type: 'image';
  readonly mimeType?: string;
  readonly data?: string;
  readonly uri?: string;
}

export interface AudioContentBlock extends BaseContentBlock {
  readonly type: 'audio';
  readonly mimeType?: string;
  readonly data?: string;
  readonly uri?: string;
}

export interface DataContentBlock extends BaseContentBlock {
  readonly type: 'data';
  readonly mimeType?: string;
  readonly value: JsonValue;
}

export interface ToolCallContentBlock extends BaseContentBlock {
  readonly type: 'tool_call';
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ToolResultContentBlock extends BaseContentBlock {
  readonly type: 'tool_result';
  readonly toolCallId: string;
  readonly output: readonly TextContentBlock[];
  readonly isError?: boolean;
}

export type ChatContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | AudioContentBlock
  | DataContentBlock
  | ToolCallContentBlock
  | ToolResultContentBlock;

export interface ChatMessage {
  readonly id?: string;
  readonly role: MessageRole;
  readonly name?: string;
  readonly content: readonly ChatContentBlock[];
  readonly metadata?: JsonObject;
}

export interface ChatToolDefinition {
  readonly id?: string;
  readonly type: 'function' | string;
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonObject;
  readonly strict?: boolean;
  readonly metadata?: JsonObject;
}

export interface ChatAttachment {
  readonly id: string;
  readonly kind: 'file' | 'image' | 'audio';
  readonly uri?: string;
  readonly mimeType?: string;
  readonly metadata?: JsonObject;
}

export interface ChatGenerationConfig {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  readonly stream?: boolean;
  readonly parallelToolCalls?: boolean;
  readonly responseFormat?: JsonObject;
  readonly metadata?: JsonObject;
}

export interface DetourEntry {
  readonly path: string;
  readonly value?: JsonValue;
  readonly reason: string;
  readonly stage: string;
}

export interface DetourState {
  readonly inbound: readonly DetourEntry[];
  readonly outbound: readonly DetourEntry[];
}

export interface ChatHubEnvelope {
  readonly version: ChatHubVersion;
  readonly conversation?: ConversationReference;
  readonly instructions?: InstructionsEnvelope;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatToolDefinition[];
  readonly config?: ChatGenerationConfig;
  readonly attachments?: readonly ChatAttachment[];
  readonly detours?: DetourState;
  readonly metadata?: JsonObject;
}
