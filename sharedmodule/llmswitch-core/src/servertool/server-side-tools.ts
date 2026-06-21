import type { JsonObject } from '../conversion/hub/types/json.js';
import { planServertoolResponseStageGateWithNative as respStageGateNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  bindServertoolContractWithNative,
  cloneJson,
  collectAdditionalClientToolCallsImpl,
  extractTextFromChatLike,
  extractToolCallsImpl,
  isClientExecCliProjectionToolCall,
  runServerSideToolEngineImpl,
  runServertoolAutoHookCallerImpl
} from './server-side-tools-impl.js';

void bindServertoolContractWithNative;

export const runServerSideToolEngine = runServerSideToolEngineImpl;
export const runServertoolAutoHookCaller = runServertoolAutoHookCallerImpl;
export const collectAdditionalClientToolCalls = collectAdditionalClientToolCallsImpl;
export const extractToolCalls = extractToolCallsImpl;
export {
  cloneJson,
  extractTextFromChatLike,
  isClientExecCliProjectionToolCall,
  bindServertoolContractWithNative
};

export function bindResponseStageGateNativeShell(args: Parameters<typeof respStageGateNative>[0]): JsonObject {
  return respStageGateNative(args) as JsonObject;
}
