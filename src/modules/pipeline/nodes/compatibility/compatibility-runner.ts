import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { CompatibilityModule } from '../../interfaces/pipeline-interfaces.js';
import type { PipelineDebugLogger } from '../../utils/debug-logger.js';
import type { PipelineSnapshotRecorder } from '../../utils/pipeline-snapshot-recorder.js';
import type { UnknownObject } from '../../../../types/common-types.js';

interface BaseRunnerOptions {
  module: CompatibilityModule;
  logger: PipelineDebugLogger;
  recorder?: PipelineSnapshotRecorder;
  entryEndpoint?: string;
  pipelineId: string;
  requestId?: string;
}

export interface CompatibilityRequestRunnerOptions extends BaseRunnerOptions {
  request: SharedPipelineRequest;
}

export interface CompatibilityResponseRunnerOptions extends BaseRunnerOptions {
  response: SharedPipelineResponse;
}

export async function runCompatibilityRequest(options: CompatibilityRequestRunnerOptions): Promise<SharedPipelineRequest> {
  const { module, request, recorder, entryEndpoint, logger, requestId } = options;
  recorder?.record({
    module: 'compatibility',
    stage: 'pipeline.compatibility.request.pre',
    hookStage: 'request_6_snapshot_pre',
    direction: 'request',
    payload: request.data,
    metadata: { entryEndpoint }
  });

  const transformed = await module.processIncoming(request);
  const out = normalizeRequestResult(request, transformed);
  logger.logTransformation(requestId || 'unknown', 'compatibility-request', request.data, out.data);

  recorder?.record({
    module: 'compatibility',
    stage: 'pipeline.compatibility.request.post',
    hookStage: 'request_6_snapshot_post',
    direction: 'request',
    payload: out.data,
    metadata: { entryEndpoint }
  });
  return out;
}

export async function runCompatibilityResponse(options: CompatibilityResponseRunnerOptions): Promise<SharedPipelineResponse> {
  const { module, response, recorder, entryEndpoint, logger, requestId } = options;
  recorder?.record({
    module: 'compatibility',
    stage: 'pipeline.compatibility.response.pre',
    hookStage: 'response_6_snapshot_pre',
    direction: 'response',
    payload: response,
    metadata: { entryEndpoint }
  });

  const transformed = await module.processOutgoing(response as unknown as UnknownObject);
  const out = normalizeResponseResult(response, transformed);
  logger.logTransformation(requestId || 'unknown', 'compatibility-response', response, out);

  recorder?.record({
    module: 'compatibility',
    stage: 'pipeline.compatibility.response.post',
    hookStage: 'response_6_snapshot_post',
    direction: 'response',
    payload: out,
    metadata: { entryEndpoint }
  });

  return out;
}

function normalizeRequestResult(original: SharedPipelineRequest, transformed: unknown): SharedPipelineRequest {
  if (isDto(transformed)) {
    return { ...(original as any), ...(transformed as any), route: original.route };
  }
  return { ...original, data: transformed as UnknownObject };
}

function normalizeResponseResult(original: SharedPipelineResponse, transformed: unknown): SharedPipelineResponse {
  if (isDto(transformed)) {
    return transformed as SharedPipelineResponse;
  }
  return { ...original, data: transformed as UnknownObject };
}

function isDto(value: unknown): value is { data: unknown; metadata: unknown } {
  return Boolean(value && typeof value === 'object' && 'data' in (value as Record<string, unknown>) && 'metadata' in (value as Record<string, unknown>));
}
