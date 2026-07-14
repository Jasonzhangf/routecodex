import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

const scriptPath = path.resolve(
  process.cwd(),
  'sharedmodule/llmswitch-core/scripts/tests/lmstudio-compatibility-tools-test.mjs'
);

describe('feature_id: debug.lmstudio_compat_tools_payload_copy_budget', () => {
  test('LM Studio compatibility projection owns only rewritten debug paths', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `
        import assert from 'node:assert/strict';
        import { applyLMStudioCompatibility } from ${JSON.stringify(scriptPath)};
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
        const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
        const tool = { type: 'function', function: { name: 'get_weather', description: 'weather', parameters: schema } };
        const request = {
          model: 'gpt-4',
          messages,
          tools: [tool],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          max_tokens: 16,
          stream: true
        };
        const processed = applyLMStudioCompatibility(request);
        assert.notStrictEqual(processed, request);
        assert.notStrictEqual(processed.parameters, request);
        assert.strictEqual(processed.messages, messages);
        assert.strictEqual(processed.tools, request.tools);
        assert.strictEqual(processed.parameters.messages, messages);
        assert.strictEqual(processed.parameters.tools[0].function.parameters, schema);
        assert.notStrictEqual(processed.parameters.tools, request.tools);
        assert.notStrictEqual(processed.parameters.tools[0], tool);
        assert.equal(processed.parameters.tool_choice, 'required');
        assert.equal(processed.parameters.maxToken, 16);
        assert.deepEqual(request.tool_choice, { type: 'function', function: { name: 'get_weather' } });
        assert.strictEqual(request.tools[0], tool);
      `
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('source rejects complete request clones and stays import-safe', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('JSON.parse(JSON.stringify(request))');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
    expect(source).toContain('export { main as runLMStudioCompatibilityToolsTest, applyLMStudioCompatibility };');
  });
});
