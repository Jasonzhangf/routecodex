import { describe, expect, it } from '@jest/globals';

import { DirectNativeHubPipelineTestWrapper } from './helpers/hub-pipeline-handle-direct-native.js';

type AnyRecord = Record<string, unknown>;

const FIRST_PROVIDER = 'openai.key1.gpt-5.5';
const SECOND_PROVIDER = 'openai.key2.gpt-5.5';

function buildNativeEngineConfig(): AnyRecord {
  return {
    virtualRouter: {
      providers: {
        [FIRST_PROVIDER]: {
          providerKey: FIRST_PROVIDER,
          providerType: 'openai',
          runtimeKey: 'openai.key1',
          modelId: 'gpt-5.5',
          outboundProfile: 'openai-responses',
          endpoint: 'mock://openai-1',
          auth: { type: 'apikey', apiKey: 'openai-key-1' },
        },
        [SECOND_PROVIDER]: {
          providerKey: SECOND_PROVIDER,
          providerType: 'openai',
          runtimeKey: 'openai.key2',
          modelId: 'gpt-5.5',
          outboundProfile: 'openai-responses',
          endpoint: 'mock://openai-2',
          auth: { type: 'apikey', apiKey: 'openai-key-2' },
        },
      },
      routing: {
        thinking: [
          {
            id: 'thinking-priority',
            priority: 100,
            mode: 'priority',
            targets: [FIRST_PROVIDER, SECOND_PROVIDER],
          },
        ],
        default: [
          {
            id: 'default-priority',
            priority: 100,
            mode: 'priority',
            targets: [FIRST_PROVIDER, SECOND_PROVIDER],
          },
        ],
      },
    },
  };
}

function buildRequest(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    requestId: 'req-native-engine-failfast-replay',
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: {
      model: 'gpt-5.5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }],
        },
      ],
    },
    metadata: {},
    metadataCenterSnapshot: {
      requestTruth: { requestId: 'req-native-engine-failfast-replay' },
      runtimeControl: {},
    },
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    ...overrides,
  };
}

async function withNativeEngine<T>(fn: (engine: DirectNativeHubPipelineTestWrapper) => Promise<T>): Promise<T> {
  const engine = new DirectNativeHubPipelineTestWrapper(buildNativeEngineConfig());
  try {
    return await fn(engine);
  } finally {
    engine.dispose();
  }
}

function selectedProviderKey(output: AnyRecord): unknown {
  const target = output.target;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    return (target as AnyRecord).providerKey;
  }
  const metadata = output.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const metadataTarget = (metadata as AnyRecord).target;
    if (metadataTarget && typeof metadataTarget === 'object' && !Array.isArray(metadataTarget)) {
      return (metadataTarget as AnyRecord).providerKey;
    }
  }
  return undefined;
}

describe('Hub Pipeline engine fail-fast direct native replay', () => {
  it('routes using explicit providerProtocol and typed retryExclusionSet through the compiled .node binding', async () => {
    await withNativeEngine(async (engine) => {
      const output = await engine.execute(buildRequest({
        retryExclusionSet: [FIRST_PROVIDER],
      }));

      expect(output.success).toBe(true);
      expect(selectedProviderKey(output)).toBe(SECOND_PROVIDER);
    });
  });

  it('does not revive flat metadata excludedProviderKeys as native route exclusion truth', async () => {
    await withNativeEngine(async (engine) => {
      const output = await engine.execute(buildRequest({
        metadata: {
          excludedProviderKeys: [FIRST_PROVIDER],
        },
      }));

      expect(output.success).toBe(true);
      expect(selectedProviderKey(output)).toBe(FIRST_PROVIDER);
    });
  });
});
