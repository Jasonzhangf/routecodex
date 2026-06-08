import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('VirtualRouter multimodal forwarder routing', () => {
  it('routes current-turn image requests through providerId-only multimodal forwarder targets', async () => {
    const root = await createTempDir('vr-forwarder-mm-');
    for (const provider of [
      {
        providerId: 'media',
        models: {
          'gpt-5.4-mini': { capabilities: ['text', 'multimodal'] }
        }
      },
      {
        providerId: 'text',
        models: {
          'gpt-5.4-mini': { capabilities: ['text'] }
        }
      }
    ]) {
      const providerDir = path.join(root, provider.providerId);
      await fs.mkdir(providerDir, { recursive: true });
      await fs.writeFile(
        path.join(providerDir, 'config.v2.json'),
        `${JSON.stringify({
          version: '2.0.0',
          providerId: provider.providerId,
          provider: {
            id: provider.providerId,
            type: 'openai',
            baseURL: `https://${provider.providerId}.example.test/v1`,
            auth: {
              entries: [{ alias: 'key1', apiKey: 'test-key' }]
            },
            models: provider.models
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    const input = await buildVirtualRouterInputV2({
      virtualrouter: {
        forwarders: {
          'fwd.gpt.gpt-5.4-mini': {
            protocol: 'openai',
            model: 'gpt-5.4-mini',
            resolutionMode: 'model-first',
            strategy: 'priority',
            stickyKey: 'none',
            targets: [
              { providerId: 'media', priority: 1 },
              { providerId: 'text', priority: 2 }
            ]
          }
        },
        routingPolicyGroups: {
          default: {
            routing: {
              multimodal: [
                {
                  id: 'multimodal-forwarder',
                  mode: 'priority',
                  targets: ['fwd.gpt.gpt-5.4-mini']
                }
              ],
              default: [
                {
                  id: 'default-text',
                  mode: 'priority',
                  targets: ['text.key1.gpt-5.4-mini']
                }
              ]
            }
          }
        }
      }
    }, root);

    const { config } = bootstrapVirtualRouterConfig({ virtualrouter: input } as any);
    const engine = new VirtualRouterEngine();
    engine.initialize(config);
    const result = engine.route(
      {
        model: 'router',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'describe this image' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
            ]
          }
        ]
      },
      {
        requestId: 'req-forwarder-mm',
        entryEndpoint: '/v1/responses',
        routecodexRoutingPolicyGroup: 'default'
      }
    );

    expect(result.target.providerKey).toBe('media.key1.gpt-5.4-mini');
    expect(result.decision.routeName).toBe('multimodal');
  });
});
