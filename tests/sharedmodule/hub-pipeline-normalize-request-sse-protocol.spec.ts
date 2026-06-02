import { describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';

const resolveSseProtocolWithNative = jest.fn();
const extractModelHintFromMetadataWithNative = jest.fn(() => 'gpt-test');
const runHubPipelineLibWithNative = jest.fn((input: Record<string, any>) => ({
  requestId: input.request.requestId,
  success: true,
  payload: input.request.payload,
  metadata: {
    ...input.request.metadata,
    endpoint: input.request.endpoint,
    entryEndpoint: input.request.entryEndpoint,
    providerProtocol: input.request.providerProtocol,
    stream: input.request.stream,
    processMode: input.request.processMode,
    direction: input.request.direction,
    stage: input.request.stage,
    target: input.request.metadata.__routecodexPreselectedRoute.target,
    routingDecision: input.request.metadata.__routecodexPreselectedRoute.decision,
    routingDiagnostics: input.request.metadata.__routecodexPreselectedRoute.diagnostics,
  },
  effectPlan: { effects: [] },
  diagnostics: [],
}));

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
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js',
  () => ({
    runHubPipelineLibWithNative,
  }),
);

const { HubPipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js'
);

const preselectedRoute = {
  target: {
    providerKey: 'test.key1.gpt-test',
    providerType: 'openai',
    outboundProfile: 'openai-chat',
    modelId: 'gpt-test',
  },
  decision: { routeName: 'test/preselected' },
  diagnostics: {},
};

describe('hub pipeline request materialization sse protocol matrix', () => {
  const matrix = [
    { protocol: 'openai-chat', providerProtocol: 'openai-chat', endpoint: '/v1/chat/completions' },
    { protocol: 'openai-responses', providerProtocol: 'openai-responses', endpoint: '/v1/responses' },
    { protocol: 'anthropic-messages', providerProtocol: 'anthropic-messages', endpoint: '/v1/messages' },
    { protocol: 'gemini-chat', providerProtocol: 'gemini-chat', endpoint: '/v1/chat/completions' },
  ] as const;

  for (const entry of matrix) {
    it(`uses ${entry.protocol} codec path and passes canonical payload into Rust total pipeline`, async () => {
      resolveSseProtocolWithNative.mockReturnValueOnce(entry.protocol);
      convertSseToJson.mockResolvedValueOnce({
        model: 'gpt-test',
        messages: [{ role: 'user', content: `hi:${entry.protocol}` }],
      });
      const pipeline = new HubPipeline({
        virtualRouter: {},
      } as any);

      const result = await pipeline.execute({
        id: `req_${entry.protocol}`,
        endpoint: entry.endpoint,
        payload: { readable: Readable.from(['event: message\ndata: {}\n\n']) },
        metadata: {
          providerProtocol: entry.providerProtocol,
          __routecodexPreselectedRoute: preselectedRoute,
          x: 1,
        },
      } as any);

      expect(resolveSseProtocolWithNative).toHaveBeenCalled();
      expect(getCodec).toHaveBeenCalledWith(entry.protocol);
      expect(runHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({
          requestId: `req_${entry.protocol}`,
          endpoint: entry.endpoint,
          entryEndpoint: entry.endpoint,
          providerProtocol: entry.providerProtocol,
          payload: expect.objectContaining({
            model: 'gpt-test',
            messages: [{ role: 'user', content: `hi:${entry.protocol}` }],
          }),
          metadata: expect.objectContaining({
            x: 1,
            __routecodexPreselectedRoute: preselectedRoute,
          }),
          stream: true,
          processMode: 'chat',
          direction: 'request',
          stage: 'inbound',
        }),
      }));
      expect(result.providerPayload).toMatchObject({ model: 'gpt-test' });
    });
  }
});
