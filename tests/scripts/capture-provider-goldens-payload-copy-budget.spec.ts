import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

const scriptPath = path.join(process.cwd(), 'scripts/tools/capture-provider-goldens.mjs');

describe('feature_id: debug.provider_golden_capture_payload_copy_budget', () => {
  test('derived config owns only rewritten paths and borrows unchanged provider branches', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `
        import assert from 'node:assert/strict';
        import { buildDerivedConfig } from ${JSON.stringify(scriptPath)};
        const models = { 'gpt-test': { aliases: ['client-test'] } };
        const auth = { apiKey: 'test-only' };
        const headers = { 'x-test': 'value' };
        const providerConfig = { id: 'provider.raw', type: 'responses-http-provider', models, auth, headers };
        const routing = { default: ['old.old'] };
        const httpserver = { host: '0.0.0.0', port: 5555, keepAliveTimeout: 1234 };
        const baseDoc = {
          virtualrouter: { providers: { 'provider.raw': providerConfig }, routing, strategy: 'priority' },
          httpserver,
          unrelated: { retained: true }
        };
        const derived = buildDerivedConfig(baseDoc, 'provider.raw', providerConfig, 5800, 'provider_safe');
        assert.notStrictEqual(derived, baseDoc);
        assert.notStrictEqual(derived.virtualrouter, baseDoc.virtualrouter);
        assert.notStrictEqual(derived.virtualrouter.providers, baseDoc.virtualrouter.providers);
        assert.notStrictEqual(derived.virtualrouter.routing, routing);
        assert.notStrictEqual(derived.httpserver, httpserver);
        assert.strictEqual(derived.unrelated, baseDoc.unrelated);
        assert.equal(derived.virtualrouter.strategy, 'priority');
        assert.equal(derived.virtualrouter.providers.provider_safe.id, 'provider_safe');
        assert.strictEqual(derived.virtualrouter.providers.provider_safe.models, models);
        assert.strictEqual(derived.virtualrouter.providers.provider_safe.auth, auth);
        assert.strictEqual(derived.virtualrouter.providers.provider_safe.headers, headers);
        assert.deepEqual(derived.virtualrouter.routing, { default: ['provider_safe.gpt-test'] });
        assert.deepEqual(derived.httpserver, { host: '127.0.0.1', port: 5800, keepAliveTimeout: 1234 });
        assert.deepEqual(baseDoc.virtualrouter.providers, { 'provider.raw': providerConfig });
        assert.equal(providerConfig.id, 'provider.raw');
      `
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('source rejects complete config clones and import-time capture execution', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('JSON.parse(JSON.stringify(baseDoc))');
    expect(source).not.toContain('JSON.parse(JSON.stringify(providerConfig))');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
    expect(source).toContain("if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)");
  });
});
