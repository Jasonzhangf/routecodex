import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

const scriptPath = path.resolve(
  process.cwd(),
  'sharedmodule/llmswitch-core/scripts/tests/hub-chain-equivalence.mjs'
);

describe('feature_id: debug.hub_chain_equivalence_payload_copy_budget', () => {
  test('sanitizePayload removes diagnostic fields without cloning complete payload graphs', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `
        import assert from 'node:assert/strict';
        import { sanitizePayload } from ${JSON.stringify(scriptPath)};
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
        const tools = [{ type: 'function', function: { name: 'tool_a', parameters: { type: 'object' } } }];
        const metadata = {
          __rcc_tools_field_present: true,
          __rcc_raw_system: 'sys',
          keep: { nested: true }
        };
        const payload = {
          model: 'gpt-test',
          messages,
          tools,
          metadata,
          __rcc_raw_system: 'raw-system',
          __rcc_provider_metadata: { provider: 'debug' },
          extra: { retained: true }
        };
        const sanitized = sanitizePayload('openai-chat', payload);
        assert.notStrictEqual(sanitized, payload);
        assert.notStrictEqual(sanitized.metadata, metadata);
        assert.strictEqual(sanitized.messages, messages);
        assert.strictEqual(sanitized.tools, tools);
        assert.strictEqual(sanitized.extra, payload.extra);
        assert.deepEqual(sanitized.metadata, { keep: metadata.keep });
        assert.equal('__rcc_raw_system' in sanitized, false);
        assert.equal('__rcc_provider_metadata' in sanitized, false);
        assert.equal(payload.metadata.__rcc_tools_field_present, true);
        assert.equal(payload.__rcc_raw_system, 'raw-system');
      `
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('source rejects full JSON clones and import-time dist/native execution', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('JSON.parse(JSON.stringify(payload))');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
    expect(source).toContain("if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)");
  });
});
