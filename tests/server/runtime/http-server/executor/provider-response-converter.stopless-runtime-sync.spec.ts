import { describe, expect, it, jest } from '@jest/globals';

import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockConvertProviderResponse = jest.fn();
const providerResponseNativeCalls = await import(
  '../../../../../src/modules/llmswitch/bridge/provider-response-native-calls.js'
);
const providerResponseNativeHost = await import(
  '../../../../../src/modules/llmswitch/bridge/provider-response-native-host.js'
);

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/provider-response-converter-host.js', () => ({
  ...providerResponseNativeCalls,
  ...providerResponseNativeHost,
  convertProviderResponse: mockConvertProviderResponse,
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: async () => ({
    record: async () => undefined,
    flush: async () => undefined,
  }),
}));

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

describe('provider-response-converter bridge metadata center binding', () => {
  it('passes the same MetadataCenter into bridge context for current-turn runtime control', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockConvertProviderResponse.mockImplementation(async ({ context }: { context: Record<string, unknown> }) => {
      const center = MetadataCenter.read(context);
      if (!center) {
        throw new Error('bridge context missing bound MetadataCenter');
      }
      center.writeRuntimeControl(
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
          symbol: 'passes the same MetadataCenter into bridge context for current-turn runtime control',
          stage: 'test'
        }
      );
      center.writeRuntimeControl(
        'stopMessageCompareContext',
        {
          decision: 'trigger',
          reason: 'stop_schema_missing',
          used: 2
        },
        {
          module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
          symbol: 'passes the same MetadataCenter into bridge context for current-turn runtime control',
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
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
        symbol: 'passes the same MetadataCenter into bridge context for current-turn runtime control',
        stage: 'test'
      }
    );
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
        symbol: 'passes the same MetadataCenter into bridge context for current-turn runtime control',
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
    expect(pipelineCenter.readRuntimeControl().stopMessageCompareContext).toEqual(
      expect.objectContaining({
        decision: 'trigger',
        reason: 'stop_schema_missing',
        used: 2
      })
    );
    expect(pipelineCenter.readRuntimeControl().serverToolLoopState).toBeUndefined();
    expect(pipelineCenter.readRuntimeControl().stopMessageState).toBeUndefined();
  });

  it('passes the same MetadataCenter into bridge context for hubStageTop debug observation', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockConvertProviderResponse.mockImplementation(async ({ context }: { context: Record<string, unknown> }) => {
      const center = MetadataCenter.read(context);
      if (!center) {
        throw new Error('bridge context missing bound MetadataCenter');
      }
      center.writeDebugSnapshot(
        'hubStageTop',
        [
          {
            stage: 'resp_inbound.stage1_codec_decode',
            totalMs: 118,
            count: 1,
          }
        ],
        {
          module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
          symbol: 'passes the same MetadataCenter into bridge context for hubStageTop debug observation',
          stage: 'test'
        }
      );
      return {
        body: {
          id: 'resp_hub_stage_top_sync',
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
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts',
        symbol: 'passes the same MetadataCenter into bridge context for hubStageTop debug observation',
        stage: 'test'
      }
    );

    await convertProviderResponseIfNeeded({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      requestId: 'req_hub_stage_top_sync',
      wantsStream: false,
      response: {
        body: {
          id: 'seed_hub_stage_top_sync',
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

    expect(pipelineCenter.readDebugSnapshot()).toEqual(
      expect.objectContaining({
        hubStageTop: [
          expect.objectContaining({
            stage: 'resp_inbound.stage1_codec_decode',
            totalMs: 118,
            count: 1
          })
        ]
      })
    );
    expect((pipelineMetadata as Record<string, unknown>).__rt).toBeUndefined();
  });
});
