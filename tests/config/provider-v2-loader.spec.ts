import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadProviderConfigsV2 } from '../../src/config/provider-v2-loader.js';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import type { UnknownRecord } from '../../src/config/virtual-router-types.js';

async function createTempDir(prefix: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return base;
}

describe('ProviderConfig v2 loader', () => {
  it('skips provider directories without config.v2.json', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'foo');
    await fs.mkdir(providerDir, { recursive: true });

    const v1Config = {
      virtualrouter: {
        providers: {
          foo: {
            type: 'mock-provider',
            baseURL: 'https://example.com',
            models: {
              'mock-1': { maxTokens: 1024 }
            }
          }
        }
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v1.json'),
      `${JSON.stringify(v1Config, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadProviderConfigsV2(root);
    expect(Object.keys(configs)).not.toContain('foo');

    const v2Path = path.join(providerDir, 'config.v2.json');
    await expect(fs.readFile(v2Path, 'utf8')).rejects.toThrow();
  });

  it('prefers existing config.v2.json when present', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'bar');
    await fs.mkdir(providerDir, { recursive: true });

    const v2Payload = {
      version: '2.0.0',
      providerId: 'bar',
      provider: {
        type: 'mock-provider',
        baseURL: 'https://bar.example.com'
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(v2Payload, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadProviderConfigsV2(root);
    expect(Object.keys(configs)).toContain('bar');
    const cfg = configs.bar;
    expect(cfg.providerId).toBe('bar');
    expect(cfg.provider.baseURL).toBe('https://bar.example.com');
  });
});

describe('buildVirtualRouterInputV2', () => {
  it('combines provider v2 configs with routing from userConfig', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });

    const v2Payload = {
      version: '2.0.0',
      providerId: 'demo',
      provider: {
        type: 'mock-provider',
        baseURL: 'https://demo.example.com'
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(v2Payload, null, 2)}\n`,
      'utf8'
    );

    const userConfig: UnknownRecord = {
      virtualrouter: {
        routing: {
          default: [
            {
              id: 'primary',
              targets: ['demo.mock-1']
            }
          ]
        }
      }
    };

    const input = await buildVirtualRouterInputV2(userConfig, root);
    expect(Object.keys(input.providers)).toEqual(['demo']);
    expect(input.providers.demo.type).toBe('mock-provider');
    expect(input.routing.default).toHaveLength(1);
    expect(input.routing.default[0].targets).toEqual(['demo.mock-1']);
  });
}
);
