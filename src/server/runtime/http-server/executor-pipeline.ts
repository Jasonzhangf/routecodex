import type { PipelineExecutionInput } from '../../handlers/types.js';
import type { HubPipeline } from './types.js';
import { asRecord } from './provider-utils.js';

export type HubPipelineResult = {
  providerPayload: Record<string, unknown>;
  target: {
    providerKey: string;
    providerType: string;
    outboundProfile: string;
    runtimeKey?: string;
    processMode?: string;
    compatibilityProfile?: string;
  };
  routingDecision?: { routeName?: string };
  processMode: string;
  metadata: Record<string, unknown>;
};

export function ensureHubPipeline(getHubPipeline: () => HubPipeline | null): HubPipeline {
  const pipeline = getHubPipeline();
  if (!pipeline) {
    throw new Error('Hub pipeline runtime is not initialized');
  }
  return pipeline;
}

export async function runHubPipeline(
  hubPipeline: HubPipeline,
  input: PipelineExecutionInput,
  metadata: Record<string, unknown>
): Promise<HubPipelineResult> {
  const payload = asRecord(input.body);
  const pipelineInput: PipelineExecutionInput & {
    payload: Record<string, unknown>;
    endpoint: string;
    id: string;
  } = {
    ...input,
    id: input.requestId,
    endpoint: input.entryEndpoint,
    metadata,
    payload
  };
  const result = await hubPipeline.execute(pipelineInput);
  if (!result.providerPayload || !result.target?.providerKey) {
    throw Object.assign(new Error('Virtual router did not produce a provider target'), {
      code: 'ERR_NO_PROVIDER_TARGET',
      requestId: input.requestId
    });
  }
  const processMode = (result.metadata?.processMode as string | undefined) ?? 'chat';
  return {
    providerPayload: result.providerPayload,
    target: result.target,
    routingDecision: result.routingDecision ?? undefined,
    processMode,
    metadata: result.metadata ?? {}
  };
}

