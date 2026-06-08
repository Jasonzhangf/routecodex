import {
  applyReasoningPayloadToMessageWithNative,
  normalizeMessageReasoningPayloadWithNative,
  resolveAnthropicToolNameWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';

export type ToolAliasMap = Record<string, string>;

export interface MessageReasoningPayload {
  summary?: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  encrypted_content?: string;
}

export function normalizeMessageReasoningPayload(
  source: unknown
): MessageReasoningPayload | undefined {
  return normalizeMessageReasoningPayloadWithNative(source) as MessageReasoningPayload | undefined;
}

export function createAnthropicToolNameResolver(aliasMap?: ToolAliasMap): (rawName: string) => string {
  return (rawName: string): string => resolveAnthropicToolNameWithNative(rawName, aliasMap);
}

export function applyReasoningPayload(
  message: Record<string, unknown>,
  reasoning: MessageReasoningPayload | undefined
): void {
  if (!reasoning) {
    return;
  }
  const updated = applyReasoningPayloadToMessageWithNative(message, reasoning);
  for (const key of Object.keys(message)) {
    delete message[key];
  }
  Object.assign(message, updated);
}
