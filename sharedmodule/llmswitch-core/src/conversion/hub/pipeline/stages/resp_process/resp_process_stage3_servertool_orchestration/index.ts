import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { ChatCompletionLike } from '../../../../response/response-mappers.js';
import type { ProviderInvoker } from '../../../../../../servertool/types.js';
import { runServertoolResponseStageOrchestrationShell } from '../../../../../../servertool/response-stage-orchestration-shell.js';

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

type ReenterPipeline = (options: {
  entryEndpoint: string;
  requestId: string;
  body: JsonObject;
  metadata?: JsonObject;
}) => Promise<{ body?: JsonObject; __sse_responses?: NodeJS.ReadableStream; format?: string }>;
type ClientInjectDispatch = (options: {
  entryEndpoint: string;
  requestId: string;
  body?: JsonObject;
  metadata?: JsonObject;
}) => Promise<{ ok: boolean; reason?: string }>;

export interface RespProcessStage3ServerToolOrchestrationOptions {
  payload: ChatCompletionLike;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  allowFollowup?: boolean;
  stageRecorder?: StageRecorder;
  providerInvoker?: ProviderInvoker;
  reenterPipeline?: ReenterPipeline;
  clientInjectDispatch?: ClientInjectDispatch;
}

export interface RespProcessStage3ServerToolOrchestrationResult {
  payload: ChatCompletionLike;
  executed: boolean;
  flowId?: string;
  skipReason?: 'no_servertool_support' | 'followup_bypass';
}

export async function runRespProcessStage3ServerToolOrchestration(
  options: RespProcessStage3ServerToolOrchestrationOptions
): Promise<RespProcessStage3ServerToolOrchestrationResult> {
  return runServertoolResponseStageOrchestrationShell({
    payload: options.payload,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol,
    allowFollowup: options.allowFollowup,
    stageRecorder: options.stageRecorder,
    providerInvoker: options.providerInvoker,
    reenterPipeline: options.reenterPipeline,
    clientInjectDispatch: options.clientInjectDispatch
  });
}
