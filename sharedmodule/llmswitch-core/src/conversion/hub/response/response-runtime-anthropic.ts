import type { JsonObject } from '../types/json.js';
import {
  buildAnthropicResponseFromChatFullWithNative,
  buildOpenAIChatFromAnthropicMessageFullWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';

type ToolAliasMap = Record<string, string>;

export interface AnthropicResponseOptions {
  aliasMap?: ToolAliasMap;
  includeToolCallIds?: boolean;
}

export function buildOpenAIChatFromAnthropicMessage(payload: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const output = buildOpenAIChatFromAnthropicMessageFullWithNative({
    payload: JSON.stringify(payload)
  });
  const parsed = JSON.parse(output);
  return JSON.parse(parsed.result);
}

export function buildAnthropicResponseFromChat(chatResponse: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const aliasMap = options?.aliasMap;
  const input = {
    chat_response: JSON.stringify(chatResponse),
    alias_map: aliasMap ? JSON.stringify(aliasMap) : undefined,
  };
  const output = buildAnthropicResponseFromChatFullWithNative(input);
  const parsed = JSON.parse(output);
  return JSON.parse(parsed.result);
}
