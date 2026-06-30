import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ToolCall } from './types.js';
import { runServertoolResponseStageWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';

export const extractToolCallsFromResponseStage = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  const stage = runServertoolResponseStageWithNative(chatResponse, requestId);
  const normalizedPayload =
    stage.normalizedPayload && typeof stage.normalizedPayload === 'object' && !Array.isArray(stage.normalizedPayload)
      ? (stage.normalizedPayload as JsonObject)
      : chatResponse;
  replaceJsonObjectInPlace(chatResponse, normalizedPayload);
  return stage.toolCalls.map((entry) => ({
    id: entry.id,
    name: entry.name,
    arguments: entry.arguments
  }));
};
