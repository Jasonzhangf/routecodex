import type { BridgeInputItem, BridgeToolDefinition } from '../../types/bridge-message-types.js';
import type { ChatToolDefinition } from '../../hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../../hub/types/json.js';
import type { ToolCallIdStyle } from '../../shared/responses-tool-utils.js';

export type Unknown = Record<string, unknown>;

export interface ResponsesRequestContext extends Unknown {
  requestId?: string;
  targetProtocol?: string;
  originalSystemMessages?: string[];
  input?: BridgeInputItem[];
  metadata?: JsonObject;
  isChatPayload?: boolean;
  isResponsesPayload?: boolean;
  historyMessages?: Array<{ role: string; content: string }>;
  currentMessage?: { role: string; content: string } | null;
  toolsRaw?: BridgeToolDefinition[];
  toolsNormalized?: Array<Record<string, unknown>>;
  parameters?: Record<string, unknown>;
  systemInstruction?: string;
  toolCallIdStyle?: ToolCallIdStyle;
}

export interface BuildChatRequestResult {
  request: Record<string, unknown>;
  toolsNormalized?: ChatToolDefinition[];
}

export interface BuildResponsesRequestResult {
  request: Record<string, unknown>;
  originalSystemMessages?: string[];
}
