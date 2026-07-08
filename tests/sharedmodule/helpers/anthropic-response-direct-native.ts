import {
  buildAnthropicResponseFromChatFullWithNative,
  buildOpenAIChatFromAnthropicMessageFullWithNative,
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.js';

type JsonObject = Record<string, unknown>;
type ToolAliasMap = Record<string, string>;

export function buildOpenAIChatFromAnthropicMessageDirectNative(payload: JsonObject): JsonObject {
  const output = buildOpenAIChatFromAnthropicMessageFullWithNative({
    payload: JSON.stringify(payload),
  });
  const parsed = JSON.parse(output);
  return JSON.parse(parsed.result);
}

export function buildAnthropicResponseFromChatDirectNative(
  chatResponse: JsonObject,
  options?: { aliasMap?: ToolAliasMap },
): JsonObject {
  const input = {
    chat_response: JSON.stringify(chatResponse),
    alias_map: options?.aliasMap ? JSON.stringify(options.aliasMap) : undefined,
  };
  const output = buildAnthropicResponseFromChatFullWithNative(input);
  const parsed = JSON.parse(output);
  return JSON.parse(parsed.result);
}
