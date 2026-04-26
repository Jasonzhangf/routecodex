import { describe, expect, it } from '@jest/globals';

import { __providerUpdateTestables } from '../../src/commands/provider-update.js';

describe('provider-update helper utilities', () => {
  it('parses csv/token thresholds/model ids/env var names', () => {
    expect(__providerUpdateTestables.splitCsv('a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(__providerUpdateTestables.splitTokenThresholds('1, 2.8, -3, abc, 4')).toEqual([1, 2, 4]);

    expect(__providerUpdateTestables.parseUniqueModelIds('gpt-5.2, gpt-5.2, gpt-4.1', 'fallback')).toEqual([
      'gpt-5.2',
      'gpt-4.1'
    ]);
    expect(__providerUpdateTestables.parseUniqueModelIds('  ', 'fallback-model')).toEqual(['fallback-model']);

    expect(__providerUpdateTestables.normalizeEnvVarName('my-provider')).toBe('MY_PROVIDER_API_KEY');
    expect(__providerUpdateTestables.normalizeEnvVarName('___')).toBe('PROVIDER_API_KEY');
  });

  it('normalizes auth/provider input nodes and credential helpers', () => {
    const authFromKeys = __providerUpdateTestables.extractApiKeyFromAuthNode({
      keys: { primary: { value: '${A_KEY}' } }
    });
    expect(authFromKeys).toBe('${A_KEY}');

    const oauth = __providerUpdateTestables.normalizeAuthForProviderUpdate({
      type: 'qwen-oauth',
      tokenFile: '~/.rcc/auth/qwen.json',
      scopes: ['a', 'b']
    });
    expect(oauth).toEqual({
      type: 'oauth',
      tokenFile: '~/.rcc/auth/qwen.json',
      clientId: undefined,
      clientSecret: undefined,
      tokenUrl: undefined,
      deviceCodeUrl: undefined,
      scopes: ['a', 'b']
    });

    const apikey = __providerUpdateTestables.normalizeAuthForProviderUpdate({
      type: 'apikey',
      apiKey: '${OPENAI_API_KEY}',
      headerName: 'Authorization'
    });
    expect(apikey).toEqual({
      type: 'apikey',
      apiKey: '${OPENAI_API_KEY}',
      headerName: 'Authorization',
      prefix: undefined
    });

    expect(__providerUpdateTestables.authTypeUsesCredentialFile('token')).toBe(true);
    expect(__providerUpdateTestables.authTypeUsesCredentialFile('apikey')).toBe(false);

    const credential = __providerUpdateTestables.readCredentialFileFromAuthNode({
      entries: [{ tokenFile: '~/.rcc/auth/custom.json' }]
    });
    expect(credential).toBe('~/.rcc/auth/custom.json');
  });

  it('builds provider update input and normalizes model maps', () => {
    const input = __providerUpdateTestables.buildProviderUpdateInputFromV2('demo', {
      type: 'responses',
      baseURL: 'https://api.example.com/v1',
      auth: { type: 'apikey', apiKey: '${DEMO_API_KEY}' }
    });
    expect(input).toEqual({
      providerId: 'demo',
      type: 'responses',
      baseURL: 'https://api.example.com/v1',
      baseUrl: 'https://api.example.com/v1',
      auth: {
        type: 'apikey',
        apiKey: '${DEMO_API_KEY}',
        headerName: undefined,
        prefix: undefined
      }
    });

    expect(__providerUpdateTestables.normalizeModelsNode(null)).toEqual({});
    expect(__providerUpdateTestables.normalizeModelsNode({ a: { supportsStreaming: true } })).toEqual({
      a: { supportsStreaming: true }
    });
  });
});
