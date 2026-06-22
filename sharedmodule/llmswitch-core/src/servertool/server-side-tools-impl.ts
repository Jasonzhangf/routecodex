import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ToolCall
} from './types.js';
import {
  extractTextFromChatLikeWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { extractToolCallsFromResponseStage } from './extract-tool-calls-shell.js';
import { orchestrateServertoolEngine } from './run-server-side-tool-engine-shell.js';

export const runServerSideToolEngine = orchestrateServertoolEngine as (
  options: ServerSideToolEngineOptions
) => Promise<ServerSideToolEngineResult>;

export const extractToolCalls = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  return extractToolCallsFromResponseStage(chatResponse, requestId);
};

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}
