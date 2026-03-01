import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordHubShadowCompareDiff } from '../../src/server/runtime/http-server/hub-shadow-compare.js';

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.sort();
  } catch {
    return [];
  }
}

describe('Unified Hub runtime shadow compare -> errorsamples', () => {
  const originalEnv = { ...process.env };
  jest.setTimeout(15000);

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('writes a diff errorsample when baseline/candidate payloads differ', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-shadow-runtime-'));
    const errorsRoot = path.join(tmp, 'errorsamples');
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsRoot;

    await recordHubShadowCompareDiff({
      requestId: 'req_shadow_runtime_test',
      entryEndpoint: '/v1/responses',
      routeHint: 'default',
      candidateMode: 'enforce',
      baselineMode: 'off',
      baselineOut: {
        providerPayload: { model: 'x', input: [{ role: 'user', content: 'hi' }] },
        target: {
          providerKey: 'mock.key1.mock-model',
          runtimeKey: 'mock.key1',
          providerType: 'mock-provider',
          outboundProfile: 'openai-responses'
        }
      },
      candidateOut: {
        providerPayload: { model: 'x', input: [{ role: 'user', content: 'hi' }], __shadow_test: 1 },
        target: {
          providerKey: 'mock.key1.mock-model',
          runtimeKey: 'mock.key1',
          providerType: 'mock-provider',
          outboundProfile: 'openai-responses'
        }
      }
    });

    const dir = path.join(errorsRoot, 'unified-hub-shadow-runtime');
    const files = await listFiles(dir);
    expect(files.some((f) => f.includes('diff-') && f.endsWith('.json'))).toBe(true);
  });

  it('writes a routing drift errorsample when only target differs and ignoreTargetSelection=true', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-shadow-runtime-routing-'));
    const errorsRoot = path.join(tmp, 'errorsamples');
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsRoot;
    process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE_IGNORE_TARGET_SELECTION = '1';

    const sharedPayload = { model: 'x', input: [{ role: 'user', content: 'hi' }] };
    await recordHubShadowCompareDiff({
      requestId: 'req_shadow_runtime_route_drift_test',
      entryEndpoint: '/v1/responses',
      routeHint: 'default',
      candidateMode: 'enforce',
      baselineMode: 'off',
      baselineOut: {
        providerPayload: sharedPayload,
        target: {
          providerKey: 'mock.key1.mock-model',
          runtimeKey: 'mock.key1',
          providerType: 'mock-provider',
          outboundProfile: 'openai-responses'
        }
      },
      candidateOut: {
        providerPayload: sharedPayload,
        target: {
          providerKey: 'mock.key2.mock-model',
          runtimeKey: 'mock.key2',
          providerType: 'mock-provider',
          outboundProfile: 'openai-responses'
        }
      }
    });

    const dir = path.join(errorsRoot, 'unified-hub-shadow-runtime-routing');
    const files = await listFiles(dir);
    expect(files.some((f) => f.includes('route-drift-') && f.endsWith('.json'))).toBe(true);
  });
});
