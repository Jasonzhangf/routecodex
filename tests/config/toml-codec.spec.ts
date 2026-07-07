import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeProviderConfigFile } from '../../src/config/provider-config-codec.js';
import { decodeUserConfigFile } from '../../src/config/user-config-codec.js';
import { parseTomlRecord } from '../../src/config/toml-basic.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('toml codec', () => {
  it('parses basic TOML records used by RouteCodex config', () => {
    const parsed = parseTomlRecord(`
      version = "2.0.0"
      virtualrouterMode = "v2"

      [httpserver]
      host = "127.0.0.1"
      port = 5555

      [virtualrouter]
      activeRoutingPolicyGroup = "default"

      [virtualrouter.routingPolicyGroups.default.routing.default]
      id = "default-primary"
      targets = ["demo.mock-1"]
    `);

    expect(parsed.version).toBe('2.0.0');
    expect((parsed.httpserver as Record<string, unknown>).port).toBe(5555);
    expect(
      (((parsed.virtualrouter as Record<string, unknown>).routingPolicyGroups as Record<string, unknown>).default as Record<string, unknown>)
        .routing
    ).toBeTruthy();
  });

  it('parses multiline arrays with inline tables used by provider auth entries', () => {
    const parsed = parseTomlRecord(`
      version = "2.0.0"
      providerId = "dbittai-gpt"

      [provider]
      id = "dbittai-gpt"
      type = "responses"

      [provider.auth]
      type = "apikey"
      entries = [
        { alias = "key1", apiKey = "\${CRS_OAI_KEY1}" }
      ]
    `);

    const provider = parsed.provider as Record<string, unknown>;
    const auth = provider.auth as Record<string, unknown>;
    expect(auth.type).toBe('apikey');
    expect(auth.entries).toEqual([
      { alias: 'key1', apiKey: '${CRS_OAI_KEY1}' }
    ]);
  });

  it('rejects legacy user config JSON files', async () => {
    const root = await mkTmp('routecodex-json-user-');
    const jsonPath = path.join(root, 'config.json');
    await fs.writeFile(jsonPath, '{"version":"2.0.0"}\n', 'utf8');
    await expect(decodeUserConfigFile(jsonPath)).rejects.toThrow('user config JSON support removed');
  });

  it('rejects legacy provider config JSON files', async () => {
    const root = await mkTmp('routecodex-json-provider-');
    const jsonPath = path.join(root, 'config.v2.json');
    await fs.writeFile(jsonPath, '{"version":"2.0.0"}\n', 'utf8');
    await expect(decodeProviderConfigFile(jsonPath)).rejects.toThrow('provider config JSON support removed');
  });
});

import { serializeTomlRecord } from '../../src/config/toml-basic.js';

describe('toml serializer roundtrip', () => {
  it('roundtrips a realistic RouteCodex config through parse -> serialize -> parse', () => {
    const input = `version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
host = "127.0.0.1"
port = 5555

[virtualrouter]
activeRoutingPolicyGroup = "default"

[[virtualrouter.routingPolicyGroups.default.routing.default]]
id = "default-primary"
targets = ["demo.mock-1"]
`;
    const parsed = parseTomlRecord(input);
    const serialized = serializeTomlRecord(parsed);
    const reparsed = parseTomlRecord(serialized);

    // Semantic equality
    expect(reparsed.version).toBe('2.0.0');
    expect(reparsed.virtualrouterMode).toBe('v2');
    expect((reparsed.httpserver as Record<string, unknown>).port).toBe(5555);
    expect((reparsed.virtualrouter as Record<string, unknown>).activeRoutingPolicyGroup).toBe('default');
    const routes = (
      ((reparsed.virtualrouter as Record<string, unknown>)
        .routingPolicyGroups as Record<string, unknown>)
        .default as Record<string, unknown>
    ).routing as Record<string, unknown>;
    const defaultRoute = routes.default as Array<Record<string, unknown>>;
    expect(defaultRoute[0].id).toBe('default-primary');
    expect(defaultRoute[0].targets).toEqual(['demo.mock-1']);
  });

  it('roundtrips a provider config through parse -> serialize -> parse', () => {
    const input = `version = "2.0.0"
providerId = "demo"

[provider]
id = "demo"
type = "anthropic"
baseURL = "https://example.test/anthropic"

[provider.models]

[provider.models."qwen3.5-plus"]
capabilities = ["web_search", "multimodal"]
`;
    const parsed = parseTomlRecord(input);
    const serialized = serializeTomlRecord(parsed);
    const reparsed = parseTomlRecord(serialized);

    expect(reparsed.version).toBe('2.0.0');
    expect(reparsed.providerId).toBe('demo');
    const provider = reparsed.provider as Record<string, unknown>;
    expect(provider.type).toBe('anthropic');
    expect(provider.baseURL).toBe('https://example.test/anthropic');
    const models = provider.models as Record<string, unknown>;
    expect((models['qwen3.5-plus'] as Record<string, unknown>).capabilities).toEqual(['web_search', 'multimodal']);
  });
});
