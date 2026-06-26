import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';

async function createTempProviderRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vr-builder-alias-contract-'));
  return root;
}

async function writeProvider(
  root: string,
  id: string,
  models: unknown,
): Promise<void> {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config.v2.json'),
    JSON.stringify(
      {
        version: '2.0.0',
        providerId: id,
        provider: {
          id,
          enabled: true,
          type: 'openai',
          baseURL: 'https://example.invalid',
          auth: {
            type: 'bearer',
            keys: [{ alias: 'key1', apiKey: 'test-key' }],
          },
          models,
        },
      },
      null,
      2,
    ),
  );
}

function buildConfig(
  forwarderId: string,
  forwarder: Record<string, unknown>,
  routingTarget: string,
) {
  return {
    version: '2.0.0',
    virtualrouter: {
      routingPolicyGroups: {
        group_alias_contract: {
          loadBalancing: { strategy: 'priority' },
          routing: {
            coding: {
              id: 'group-alias-contract-coding',
              priority: 200,
              mode: 'priority',
              targets: [routingTarget],
              thinking: 'low',
            },
          },
        },
      },
      forwarders: {
        [forwarderId]: forwarder,
      },
    },
  };
}

/**
 * Provider forwarder targets must reference canonical model IDs declared in
 * `provider.models`. Per Jason 2026-06-20, `provider.models.<id>.aliases` is
 * display-only for `/v1/models` and must never flow into VR routed targets
 * or provider wire `body.model`. Forwarder authoring is single-model only:
 * target entries may not override `modelId`. This locks `providerDeclaresModel` /
 * `resolveForwarderTargetProviderKeys` so a forwarder whose top-level model
 * matches a declared alias (but is not a canonical key) is rejected with a clear
 * error instead of silently generating a runtime key like
 * `<provider>.<alias>.<aliasModelId>`.
 */
describe('virtual-router-builder: provider model alias contract', () => {
  it('rejects a forwarder whose modelId is only an alias under provider.models.<canonical>.aliases', async () => {
    const root = await createTempProviderRoot();
    try {
      await writeProvider(root, 'alias-provider', {
        'DeepSeek-V4-Pro': {
          aliases: ['deepseek-v4-pro'],
          supportsStreaming: true,
        },
      });
      const forwarder = {
        protocol: 'openai',
        model: 'deepseek-v4-pro',
        resolutionMode: 'model-first',
        strategy: 'priority',
        stickyKey: 'none',
        targets: [{ providerId: 'alias-provider', priority: 1 }],
      };
      await expect(
        buildVirtualRouterInputV2(
          buildConfig('fwd.alias-contract', forwarder, 'fwd.alias-contract') as unknown as Record<string, unknown>,
          root,
          { routingPolicyGroup: 'group_alias_contract' },
        ),
      ).rejects.toThrow(
        /forwarder-config.*target 'alias-provider' does not declare model 'deepseek-v4-pro'/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a forwarder alias target when provider.models is array-shaped and the alias appears in model.aliases', async () => {
    const root = await createTempProviderRoot();
    try {
      await writeProvider(root, 'alias-provider-array', {
        DeepSeek_V4_Pro: {
          id: 'DeepSeek_V4_Pro',
          aliases: ['deepseek-v4-pro'],
        },
      });
      const forwarder = {
        protocol: 'openai',
        model: 'deepseek-v4-pro',
        resolutionMode: 'model-first',
        strategy: 'priority',
        stickyKey: 'none',
        targets: [{ providerId: 'alias-provider-array', priority: 1 }],
      };
      await expect(
        buildVirtualRouterInputV2(
          buildConfig('fwd.alias-contract', forwarder, 'fwd.alias-contract') as unknown as Record<string, unknown>,
          root,
          { routingPolicyGroup: 'group_alias_contract' },
        ),
      ).rejects.toThrow(
        /forwarder-config.*target 'alias-provider-array' does not declare model 'deepseek-v4-pro'/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a forwarder whose modelId matches the canonical provider.models key', async () => {
    const root = await createTempProviderRoot();
    try {
      await writeProvider(root, 'canonical-provider', {
        'DeepSeek-V4-Pro': {
          aliases: ['deepseek-v4-pro'],
          supportsStreaming: true,
        },
      });
      const forwarder = {
        protocol: 'openai',
        model: 'DeepSeek-V4-Pro',
        resolutionMode: 'model-first',
        strategy: 'priority',
        stickyKey: 'none',
        targets: [{ providerId: 'canonical-provider', priority: 1 }],
      };
      const input = await buildVirtualRouterInputV2(
        buildConfig('fwd.alias-contract', forwarder, 'fwd.alias-contract') as unknown as Record<string, unknown>,
        root,
        { routingPolicyGroup: 'group_alias_contract' },
      );
      expect(input).toBeTruthy();
      expect(input.forwarders).toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('accepts target-level modelId when it matches the forwarder model', async () => {
    const root = await createTempProviderRoot();
    try {
      await writeProvider(root, 'canonical-provider', {
        'DeepSeek-V4-Pro': {
          aliases: ['deepseek-v4-pro'],
          supportsStreaming: true,
        },
      });
      const forwarder = {
        protocol: 'openai',
        model: 'DeepSeek-V4-Pro',
        resolutionMode: 'model-first',
        strategy: 'priority',
        stickyKey: 'none',
        targets: [{ providerId: 'canonical-provider', modelId: 'DeepSeek-V4-Pro', priority: 1 }],
      };
      const input = await buildVirtualRouterInputV2(
        buildConfig('fwd.alias-contract', forwarder, 'fwd.alias-contract') as unknown as Record<string, unknown>,
        root,
        { routingPolicyGroup: 'group_alias_contract' },
      );
      expect(input).toBeTruthy();
      expect(input.forwarders).toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects target-level modelId override when it conflicts with the forwarder model', async () => {
    const root = await createTempProviderRoot();
    try {
      await writeProvider(root, 'canonical-provider', {
        'DeepSeek-V4-Pro': {
          aliases: ['deepseek-v4-pro'],
          supportsStreaming: true,
        },
      });
      const forwarder = {
        protocol: 'openai',
        model: 'DeepSeek-V4-Pro',
        resolutionMode: 'model-first',
        strategy: 'priority',
        stickyKey: 'none',
        targets: [{ providerId: 'canonical-provider', modelId: 'DeepSeek-V4-Pro-Alt', priority: 1 }],
      };
      await expect(
        buildVirtualRouterInputV2(
          buildConfig('fwd.alias-contract', forwarder, 'fwd.alias-contract') as unknown as Record<string, unknown>,
          root,
          { routingPolicyGroup: 'group_alias_contract' },
        ),
      ).rejects.toThrow(/must match forwarder\.model/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
