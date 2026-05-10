import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildRouteCodexSemanticSnapshot, compareSemanticValue } from '../../src/config/config-semantic-compare.js';
import { decodeUserConfigFile } from '../../src/config/user-config-codec.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('toml shadow semantic compare', () => {
  it('materializes equivalent runtime semantics for JSON and TOML user config with shared provider root', async () => {
    const root = await mkTmp('routecodex-toml-shadow-semantic-');
    const providerRoot = path.join(root, 'provider');
    const providerDir = path.join(providerRoot, 'ali-coding-plan');
    await fs.mkdir(providerDir, { recursive: true });

    const providerJson = {
      version: '2.0.0',
      providerId: 'ali-coding-plan',
      provider: {
        id: 'ali-coding-plan',
        type: 'anthropic',
        baseURL: 'https://example.test/anthropic',
        models: {
          'glm-5': { capabilities: ['web_search'] },
          'qwen3.5-plus': { capabilities: ['web_search', 'multimodal'] }
        }
      }
    };
    await fs.writeFile(path.join(providerDir, 'config.v2.json'), `${JSON.stringify(providerJson, null, 2)}\n`, 'utf8');

    const jsonPath = path.join(root, 'config.json');
    const tomlPath = path.join(root, 'config.toml');

    const jsonPayload = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      httpserver: { host: '127.0.0.1', port: 5555 },
      virtualrouter: {
        activeRoutingPolicyGroup: 'default',
        routingPolicyGroups: {
          default: {
            routing: {
              default: [{ id: 'default-primary', targets: ['ali-coding-plan.glm-5'] }],
              multimodal: [{ id: 'manual-multimodal', targets: ['ali-coding-plan.qwen3.5-plus'] }],
              web_search: [{ id: 'manual-search', targets: ['ali-coding-plan.glm-5'] }]
            },
            session: {
              reasoningStopMode: 'on'
            }
          }
        }
      }
    };

    const tomlPayload = `
version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
host = "127.0.0.1"
port = 5555

[virtualrouter]
activeRoutingPolicyGroup = "default"

[virtualrouter.routingPolicyGroups.default.session]
reasoningStopMode = "on"

[[virtualrouter.routingPolicyGroups.default.routing.default]]
id = "default-primary"
targets = ["ali-coding-plan.glm-5"]

[[virtualrouter.routingPolicyGroups.default.routing.multimodal]]
id = "manual-multimodal"
targets = ["ali-coding-plan.qwen3.5-plus"]

[[virtualrouter.routingPolicyGroups.default.routing.web_search]]
id = "manual-search"
targets = ["ali-coding-plan.glm-5"]
`;

    await fs.writeFile(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');
    await fs.writeFile(tomlPath, tomlPayload, 'utf8');

    const decodedJson = await decodeUserConfigFile(jsonPath);
    const decodedToml = await decodeUserConfigFile(tomlPath);

    const jsonSnapshot = await buildRouteCodexSemanticSnapshot(decodedJson.parsed, providerRoot);
    const tomlSnapshot = await buildRouteCodexSemanticSnapshot(decodedToml.parsed, providerRoot);

    expect(compareSemanticValue(jsonSnapshot.userConfig, tomlSnapshot.userConfig).equal).toBe(true);
    expect(compareSemanticValue(jsonSnapshot.providerProfiles, tomlSnapshot.providerProfiles).equal).toBe(true);
  });
});
