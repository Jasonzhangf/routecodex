import { describe, expect, it, jest } from '@jest/globals';

describe('processSuccessfulProviderResponse legacy stopless contract removal', () => {


  it('does not reject responses completed payloads just because legacy stopless metadata remains', async () => {
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    await expect(processSuccessfulProviderResponse({
      inputRequestId: 'req-stopless-removed-1',
      entryEndpoint: '/v1/responses',
      providerKey: 'test.key1',
      providerId: 'test',
      providerProtocol: 'openai-responses',
      providerPayload: {},
      normalized: {
        status: 200,
        body: {
          status: 'completed',
          output_text: 'done without reasoningStop'
        }
      } as any,
      converted: {
        status: 200,
        body: {
          status: 'completed',
          output_text: 'done without reasoningStop'
        }
      } as any,
      mergedMetadata: {
        reasoningStopMode: 'on',
        reasoningStopArmed: true
      },
      bypassTrafficGovernor: true,
      trafficGovernor: {} as any,
      runtimeKey: 'runtime:test',
      stats: {
        recordToolUsage: jest.fn()
      } as any,
      attempt: 1,
      logStage: () => undefined,
      logNonBlockingError: () => undefined,
      queuePayloadContractErrorsample: () => undefined,
      writeProviderSnapshot: async () => undefined
    })).resolves.toMatchObject({
      convertedStatus: 200
    });
  });

  it('does not reject chat stop payloads just because legacy stopless mode was on', async () => {
    const { processSuccessfulProviderResponse } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-executor-provider-response.js'
    );

    await expect(processSuccessfulProviderResponse({
      inputRequestId: 'req-stopless-removed-2',
      entryEndpoint: '/v1/chat/completions',
      providerKey: 'test.key1',
      providerId: 'test',
      providerProtocol: 'openai-chat',
      providerPayload: {},
      normalized: {
        status: 200,
        body: {
          id: 'chatcmpl-stopless-removed',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '阶段完成'
              }
            }
          ]
        }
      } as any,
      converted: {
        status: 200,
        body: {
          id: 'chatcmpl-stopless-removed',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '阶段完成'
              }
            }
          ]
        }
      } as any,
      mergedMetadata: {
        reasoningStopMode: 'endless',
        reasoningStopArmed: true
      },
      bypassTrafficGovernor: true,
      trafficGovernor: {} as any,
      runtimeKey: 'runtime:test',
      stats: {
        recordToolUsage: jest.fn()
      } as any,
      attempt: 1,
      logStage: () => undefined,
      logNonBlockingError: () => undefined,
      queuePayloadContractErrorsample: () => undefined,
      writeProviderSnapshot: async () => undefined
    })).resolves.toMatchObject({
      convertedStatus: 200
    });
  });
});
