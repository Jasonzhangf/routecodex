import { describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';

const resolveSseProtocolWithNative = jest.fn();
const extractModelHintFromMetadataWithNative = jest.fn(() => 'gpt-test');
const normalizeHubEndpointWithNative = jest.fn((endpoint: string) => endpoint);
const runHubPipelineOrchestrationWithNative = jest.fn((input: Record<string, unknown>) => ({
  success: true,
  payload: input.payload,
  metadata: input.metadata,
}));
const readHubPipelineSemanticMapperHintWithNative = jest.fn(() => null);
const coerceHubPipelineStageTagWithNative = jest.fn(() => null);
const resolveHubPipelineDirectionWithNative = jest.fn(() => null);
const resolveHubPipelineProcessModeWithNative = jest.fn(() => null);
const resolveHubPipelineProviderProtocolWithNative = jest.fn(() => null);
const resolveHubPipelineRouteHintWithNative = jest.fn(() => null);
const resolveHubPipelineStageWithNative = jest.fn(() => null);
const normalizeHubPipelineMetadataShapeWithNative = jest.fn((metadata: Record<string, unknown>) => metadata);
const decideHubPipelineDirectionWithNative = jest.fn((_stage: string, fallback: string) => fallback);
const resolveHubPipelineDirectionStageWithNative = jest.fn((stage: string) => stage);
const resolveHubPipelineProviderProtocolAndProcessModeWithNative = jest.fn((args: any) => ({
  providerProtocol: args.fallbackProviderProtocol,
  processMode: args.fallbackProcessMode,
}));
const resolveHubPipelineProcessStageWithNative = jest.fn((stage: string) => ({
  directionStage: stage,
  inbound: stage !== 'outbound',
  stageTag: stage,
}));
const resolveHubPipelineStreamWithNative = jest.fn((_payload: any, fallback: boolean) => fallback);
const resolveHubProviderProtocolWithNative = jest.fn((value: unknown) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'openai-chat';
});
const resolveHubPolicyOverrideFromMetadataWithNative = jest.fn(() => undefined);
const resolveHubShadowCompareConfigWithNative = jest.fn(() => undefined);

const convertSseToJson = jest.fn(async () => ({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }));
const getCodec = jest.fn(() => ({ convertSseToJson }));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/sse/index.js',
  () => ({
    defaultSseCodecRegistry: {
      get: getCodec,
    },
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    resolveSseProtocolWithNative,
    extractModelHintFromMetadataWithNative,
    normalizeHubEndpointWithNative,
    runHubPipelineOrchestrationWithNative,
    readHubPipelineSemanticMapperHintWithNative,
    coerceHubPipelineStageTagWithNative,
    resolveHubPipelineDirectionWithNative,
    resolveHubPipelineProcessModeWithNative,
    resolveHubPipelineProviderProtocolWithNative,
    resolveHubPipelineRouteHintWithNative,
    resolveHubPipelineStageWithNative,
    normalizeHubPipelineMetadataShapeWithNative,
    decideHubPipelineDirectionWithNative,
    resolveHubPipelineDirectionStageWithNative,
    resolveHubPipelineProviderProtocolAndProcessModeWithNative,
    resolveHubPipelineProcessStageWithNative,
    resolveHubPipelineStreamWithNative,
    resolveHubProviderProtocolWithNative,
    resolveHubPolicyOverrideFromMetadataWithNative,
    resolveHubShadowCompareConfigWithNative,
  }),
);

const { normalizeHubPipelineRequest } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request.js'
);

describe('hub pipeline normalize request sse protocol matrix', () => {
  const matrix = [
    { protocol: 'openai-chat', providerProtocol: 'openai-chat', endpoint: '/v1/chat/completions' },
    { protocol: 'openai-responses', providerProtocol: 'openai-responses', endpoint: '/v1/responses' },
    { protocol: 'anthropic-messages', providerProtocol: 'anthropic-messages', endpoint: '/v1/messages' },
    { protocol: 'gemini-chat', providerProtocol: 'gemini-chat', endpoint: '/v1/chat/completions' },
  ] as const;

  for (const entry of matrix) {
    it(`uses ${entry.protocol} codec path and keeps normalized payload canonical`, async () => {
      resolveSseProtocolWithNative.mockReturnValueOnce(entry.protocol);
      convertSseToJson.mockResolvedValueOnce({
        model: 'gpt-test',
        messages: [{ role: 'user', content: `hi:${entry.protocol}` }],
      });

      const normalized = await normalizeHubPipelineRequest({
        id: `req_${entry.protocol}`,
        endpoint: entry.endpoint,
        providerProtocol: entry.providerProtocol,
        payload: { readable: Readable.from(['event: message\ndata: {}\n\n']) },
        metadata: { x: 1 },
      } as any);

      expect(resolveSseProtocolWithNative).toHaveBeenCalled();
      expect(getCodec).toHaveBeenCalledWith(entry.protocol);
      expect(normalized.payload).toMatchObject({
        model: 'gpt-test',
      });
      expect((normalized.payload as Record<string, unknown>).messages).toEqual([
        { role: 'user', content: `hi:${entry.protocol}` },
      ]);
    });
  }
});
