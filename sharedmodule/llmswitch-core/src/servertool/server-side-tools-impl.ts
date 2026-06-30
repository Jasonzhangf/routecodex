import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult
} from './types.js';
import {
  extractTextFromChatLikeWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { orchestrateServertoolEngine } from './run-server-side-tool-engine-shell.js';

export const runServerSideToolEngine = orchestrateServertoolEngine as (
  options: ServerSideToolEngineOptions
) => Promise<ServerSideToolEngineResult>;

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}
