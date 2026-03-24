import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { InitProviderTemplate } from '../../src/cli/config/init-provider-catalog.js';
import {
  asRecord,
  backupFileBestEffort,
  buildRouting,
  buildV2ConfigFromExisting,
  collectOauthTokenNames,
  collectProviderKeyMasks,
  computeBackupPath,
  ensureTargetProvidersExist,
  getProviderSummaryLine,
  getProviderV2Path,
  inferDefaultModel,
  inspectConfigState,
  isBackInput,
  loadProviderV2Map,
  maskSecretTail3,
  mergeRecordsPreferExisting,
  normalizeEnvVarName,
  normalizeHost,
  normalizePort,
  printConfiguredProviders,
  readPrimaryTargetFromRoute,
  readProviderV2Payload,
  readProvidersFromV1,
  readRoutingFromConfig,
  resolveSelectedTemplates,
  writeProviderV2
} from '../../src/cli/commands/init/basic.js';

function tmpDir(prefix = 'init-basic-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('init basic utilities', () => {
  it('normalizes host/port/default-model/back input helpers', () => {
    expect(normalizeHost(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(normalizeHost('   ')).toBeUndefined();
    expect(normalizePort('5555')).toBe(5555);
    expect(normalizePort(8080.9)).toBe(8080);
    expect(normalizePort('0')).toBeUndefined();

    expect(inferDefaultModel({ defaultModel: '  model-a  ', models: { 'model-b': {} } })).toBe('model-a');
    expect(inferDefaultModel({ models: { 'model-first': {} } })).toBe('model-first');
    expect(inferDefaultModel({})).toBe('gpt-4o-mini');

    expect(isBackInput('b')).toBe(true);
    expect(isBackInput(' back ')).toBe(true);
    expect(isBackInput('0')).toBe(true);
    expect(isBackInput('no')).toBe(false);
  });

  it('reads routing from virtualrouter/active/default/root fallbacks', () => {
    const direct = readRoutingFromConfig({
      virtualrouter: { routing: { default: [{ targets: ['a.m'] }] } }
    });
    expect(readPrimaryTargetFromRoute(direct.default)).toBe('a.m');

    const active = readRoutingFromConfig({
      virtualrouter: {
        activeRoutingPolicyGroup: 'x',
        routingPolicyGroups: {
          x: { routing: { default: [{ targets: ['b.m'] }] } }
        }
      }
    });
    expect(readPrimaryTargetFromRoute(active.default)).toBe('b.m');

    const fallbackDefaultGroup = readRoutingFromConfig({
      virtualrouter: {
        routingPolicyGroups: {
          default: { routing: { default: [{ targets: ['c.m'] }] } }
        }
      }
    });
    expect(readPrimaryTargetFromRoute(fallbackDefaultGroup.default)).toBe('c.m');

    const root = readRoutingFromConfig({ routing: { default: [{ targets: ['d.m'] }] } });
    expect(readPrimaryTargetFromRoute(root.default)).toBe('d.m');
  });

  it('reads providers from v1 virtualrouter/root and merges records', () => {
    const providersFromVr = readProvidersFromV1({
      virtualrouter: {
        providers: {
          a: { type: 'openai' },
          b: 'invalid'
        }
      }
    });
    expect(Object.keys(providersFromVr)).toEqual(['a']);

    const providersFromRoot = readProvidersFromV1({
      providers: {
        c: { type: 'responses', extra: 1 },
        d: null
      }
    });
    expect(Object.keys(providersFromRoot)).toEqual(['c']);

    const merged = mergeRecordsPreferExisting(
      { auth: { type: 'apikey', apiKey: '${X}' }, models: { a: {} }, arr: [1] },
      { auth: { apiKey: '${Y}' }, arr: [], enabled: true }
    );
    expect((merged.auth as Record<string, unknown>).apiKey).toBe('${Y}');
    expect(merged.arr).toEqual([1]);
    expect(merged.enabled).toBe(true);
  });

  it('inspects config state and provider payload safely', () => {
    const dir = tmpDir();
    const missing = inspectConfigState(fs, path.join(dir, 'missing.json'));
    expect(missing.kind).toBe('missing');

    const invalidPath = path.join(dir, 'invalid.json');
    fs.writeFileSync(invalidPath, '{oops', 'utf8');
    const invalid = inspectConfigState(fs, invalidPath);
    expect(invalid.kind).toBe('invalid');

    const v2Path = path.join(dir, 'v2.json');
    fs.writeFileSync(v2Path, JSON.stringify({ virtualrouterMode: 'v2' }), 'utf8');
    const v2 = inspectConfigState(fs, v2Path);
    expect(v2.kind).toBe('v2');

    const payloadPath = path.join(dir, 'provider.json');
    fs.writeFileSync(
      payloadPath,
      JSON.stringify({ version: '2.0.0', providerId: 'x', provider: { id: 'x', models: { m: {} } } }),
      'utf8'
    );
    expect(readProviderV2Payload(fs, payloadPath)?.providerId).toBe('x');
    fs.writeFileSync(payloadPath, JSON.stringify({ providerId: '', provider: {} }), 'utf8');
    expect(readProviderV2Payload(fs, payloadPath)).toBeNull();
  });

  it('writes/loads provider v2 config and computes backup paths', () => {
    const dir = tmpDir();
    const root = path.join(dir, 'provider');
    const filePath = writeProviderV2(fs, path, root, 'demo', {
      id: 'demo',
      enabled: true,
      models: { 'm-1': { supportsStreaming: true } },
      auth: { type: 'apikey', apiKey: '${DEMO_API_KEY}' }
    });
    expect(fs.existsSync(filePath)).toBe(true);

    const map = loadProviderV2Map(fs, path, root);
    expect(Object.keys(map)).toEqual(['demo']);
    expect(getProviderV2Path(path, root, 'demo')).toBe(filePath);

    const backup1 = backupFileBestEffort(fs, filePath);
    expect(backup1).toBeTruthy();
    const backup2 = computeBackupPath(fs, filePath);
    expect(backup2).toContain('.bak.');
  });

  it('builds provider summary lines and prints configured providers', () => {
    const payload = {
      version: '2.0.0',
      providerId: 'demo',
      provider: {
        id: 'demo',
        enabled: true,
        baseURL: 'https://api.example.com/v1',
        models: { a: {}, b: {} },
        auth: {
          type: 'oauth',
          apiKey: 'abc123xyz',
          tokenFile: '/tmp/token-main.json',
          entries: [{ alias: 'acc1', tokenFile: '/tmp/token-1.json' }]
        }
      }
    };
    expect(maskSecretTail3('abc123')).toBe('****123');
    expect(collectProviderKeyMasks(asRecord(payload.provider))).toEqual(['****xyz']);
    expect(collectOauthTokenNames(asRecord(payload.provider))).toEqual(['token-main.json', 'acc1(token-1.json)']);

    const line = getProviderSummaryLine('demo', payload);
    expect(line).toContain('models=2');
    expect(line).toContain('oauth=');
    expect(line).toContain('baseURL=https://api.example.com/v1');

    const lines: string[] = [];
    printConfiguredProviders(
      { info: (msg) => lines.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      { demo: payload }
    );
    expect(lines.join('\n')).toContain('Configured providers (1)');
    expect(lines.join('\n')).toContain('demo | enabled');
  });

  it('resolves selected templates with external fallback + env var normalization', () => {
    const catalogTemplate: InitProviderTemplate = {
      id: 'openai',
      label: 'OpenAI',
      description: 'x',
      provider: { id: 'openai', models: { 'gpt-4.1': { supportsStreaming: true } } },
      defaultModel: 'gpt-4.1'
    };
    const catalogById = new Map<string, InitProviderTemplate>([['openai', catalogTemplate]]);

    const builtinOnly = resolveSelectedTemplates(['openai', 'unknown'], catalogById, { allowExternal: false });
    expect(builtinOnly.map((item) => item.id)).toEqual(['openai']);

    const mixed = resolveSelectedTemplates(['openai', 'my-provider'], catalogById, {
      allowExternal: true,
      defaultModel: 'gpt-4.1-mini'
    });
    expect(mixed.map((item) => item.id)).toEqual(['openai', 'my-provider']);
    expect(mixed[1].provider.auth).toEqual({ type: 'apikey', apiKey: '${MY_PROVIDER_API_KEY}' });
    expect(mixed[1].defaultModel).toBe('gpt-4.1-mini');
    expect(normalizeEnvVarName('my-provider')).toBe('MY_PROVIDER_API_KEY');
  });

  it('checks missing target providers and builds v2 config object', () => {
    const routing = buildRouting('openai.gpt-4.1', { thinking: 'missing.model' });
    const missing = ensureTargetProvidersExist(routing, new Set(['openai']));
    expect(missing).toEqual(['missing.model']);

    const nextConfig = buildV2ConfigFromExisting({ legacy: true }, routing, '127.0.0.1', 5555);
    expect(nextConfig.virtualrouterMode).toBe('v2');
    expect(asRecord(nextConfig.httpserver).host).toBe('127.0.0.1');
    expect(asRecord(nextConfig.httpserver).port).toBe(5555);
  });
});
