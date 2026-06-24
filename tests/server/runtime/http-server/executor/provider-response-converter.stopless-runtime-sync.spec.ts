import { describe, expect, it, jest } from '@jest/globals';

import { createBridgeHttpServerMock } from '../../../../helpers/bridge-http-server-mock.js';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockConvertProviderResponse = jest.fn();
const mockRequireCoreDist = jest.fn(() => ({
  normalizeResponsesToolCallArgumentsForClientWithNative: () => ({}),
}));
const mockImportCoreDist = jest.fn(async () => ({
  normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) =>
    (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
}));

const mockBridgeModule = () => createBridgeHttpServerMock({
  convertProviderResponse: mockConvertProviderResponse,
  requireCoreDist: mockRequireCoreDist,
  importCoreDist: mockImportCoreDist,
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

async function loadConverter() {
  const mod = await import('../../../../../src/server/runtime/http-server/executor/provider-response-converter.js');
  return mod.convertProviderResponseIfNeeded;
}

function createDeps() {
  return {
    runtimeManager: {
      resolveRuntimeKey: () => undefined,
      getHandleByRuntimeKey: () => undefined,
    },
    executeNested: async () => ({ body: { ok: true } } as any),
  };
}

describe('provider-response-converter stopless runtime sync', () => {
  it('syncs current-turn stopless runtime control back into pipeline metadata before continuation save', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockConvertProviderResponse.mockImplementation(async ({ context }: { context: Record<string, unknown> }) => {
      const isolatedAdapterCenter = new MetadataCenter();
      MetadataCenter.bind(context, isolatedAdapterCenter);
      if (context.metadata && typeof context.metadata === 'object' && !Array.isArray(context.metadata)) {
        MetadataCenter.bind(context.metadata as Record<string, unknown>, isolatedAdapterCenter);
      }
      isolatedAdapterCenter.writeRuntimeControl(
        'stopless',
        {
          flowId: 'stop_message_flow',
          repeatCount: 2,
          maxRepeats: 3,
          triggerHint: 'no_schema',
          continuationPrompt: '请补齐 stop schema 后继续。',
          active: true,
        },
        {
          module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
          symbol: 'syncs current-turn stopless runtime control back into pipeline metadata before continuation save',
          stage: 'test'
        }
      );
      isolatedAdapterCenter.writeRuntimeControl(
        'serverToolLoopState',
        {
          flowId: 'stop_message_flow',
          repeatCount: 2,
          maxRepeats: 3,
          triggerHint: 'no_schema',
          schemaFeedback: {
            reasonCode: 'stop_schema_missing',
            missingFields: ['stopreason', 'next_step']
          }
        },
        {
          module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
          symbol: 'syncs current-turn stopless runtime control back into pipeline metadata before continuation save',
          stage: 'test'
        }
      );
      isolatedAdapterCenter.writeRuntimeControl(
        'stopMessageState',
        {
          stopMessageText: '请补齐 stop schema 后继续。',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1,
          stopMessageStageMode: 'on'
        },
        {
          module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
          symbol: 'syncs current-turn stopless runtime control back into pipeline metadata before continuation save',
          stage: 'test'
        }
      );
      return {
        body: {
          id: 'resp_stopless_sync',
          object: 'response',
          status: 'completed',
          output: []
        }
      };
    });

    const convertProviderResponseIfNeeded = await loadConverter();
    const pipelineMetadata: Record<string, unknown> = {};
    const pipelineCenter = MetadataCenter.attach(pipelineMetadata);
    pipelineCenter.writeRuntimeControl(
      'stopless',
      {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        triggerHint: 'no_schema',
        active: true
      },
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
        symbol: 'syncs current-turn stopless runtime control back into pipeline metadata before continuation save',
        stage: 'test'
      }
    );

    await convertProviderResponseIfNeeded({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      requestId: 'req_stopless_sync',
      wantsStream: false,
      response: {
        body: {
          id: 'seed_stopless_sync',
          object: 'response',
          status: 'completed',
          output: []
        }
      } as any,
      pipelineMetadata,
      entryOriginRequest: {
        model: 'gpt-test',
        input: '继续'
      }
    } as any, createDeps() as any);

    expect(pipelineCenter.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        triggerHint: 'no_schema',
        continuationPrompt: '请补齐 stop schema 后继续。',
        active: true
      })
    );
    expect(pipelineCenter.readRuntimeControl().serverToolLoopState).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        triggerHint: 'no_schema',
      })
    );
    expect(pipelineCenter.readRuntimeControl().stopMessageState).toEqual(
      expect.objectContaining({
        stopMessageText: '请补齐 stop schema 后继续。',
        stopMessageMaxRepeats: 3,
        stopMessageUsed: 1,
        stopMessageStageMode: 'on'
      })
    );
  });
});
