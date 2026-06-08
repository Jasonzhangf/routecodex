import type { JsonObject } from '../types/json.js';
import {
  buildAnthropicResponseFromChatFullWithNative,
  buildOpenAIChatFromAnthropicMessageFullWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import type { ToolAliasMap } from './response-runtime-anthropic-helpers.js';

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
    responses_reasoning: (chatResponse as any)?.__responses_reasoning
      ? JSON.stringify((chatResponse as any).__responses_reasoning)
      : undefined,
    responses_output_text_meta: (chatResponse as any)?.__responses_output_text_meta
      ? JSON.stringify((chatResponse as any).__responses_output_text_meta)
      : undefined,
    responses_payload_snapshot: (chatResponse as any)?.__responses_payload_snapshot
      ? JSON.stringify((chatResponse as any).__responses_payload_snapshot)
      : undefined,
    responses_passthrough: (chatResponse as any)?.__responses_passthrough
      ? JSON.stringify((chatResponse as any).__responses_passthrough)
      : undefined,
  };
  const output = buildAnthropicResponseFromChatFullWithNative(input);
  const parsed = JSON.parse(output);
  return JSON.parse(parsed.result);
}
