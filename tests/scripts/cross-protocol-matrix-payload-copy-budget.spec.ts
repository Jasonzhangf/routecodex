import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

describe('feature_id: debug.cross_protocol_matrix_payload_copy_budget', () => {
  test('source rejects cross-protocol JSON round-trip canonicalization clones', () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        'sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs'
      ),
      'utf8'
    );

    expect(source).not.toContain('JSON.parse(JSON.stringify(chat || {}))');
    expect(source).not.toContain('JSON.parse(JSON.stringify(fn.parameters))');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
  });

  test('canonicalizeChat normalizes without mutating the source chat graph', () => {
    const modulePath = path.resolve(
      process.cwd(),
      'sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs'
    );
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        input: `
          import assert from 'node:assert/strict';
          import { canonicalizeChat } from ${JSON.stringify(modulePath)};
          const parameters = { type: 'object', properties: { value: { type: 'string' } } };
          const original = {
            model: 'gpt-test',
            providerType: 'openai',
            metadata: { providerKey: 'internal.provider', sessionId: 'sess_1' },
            tools: [{ type: 'function', function: { name: ' tool_a ', parameters } }],
            messages: [
              { role: 'user', content: [{ type: 'text', text: ' hello ' }] },
              { role: 'assistant', content: '', tool_calls: [{ id: 'call_original', index: 0, type: 'function', function: { name: 'tool_a', arguments: '{"b":2,"a":1}' } }] },
              { role: 'tool', id: 'tool_msg_id', name: 'tool_a', tool_call_id: 'call_original', content: ' done ' }
            ]
          };
          const canonical = canonicalizeChat(original);
          assert.notStrictEqual(canonical, original);
          assert.equal(canonical.providerType, undefined);
          assert.deepEqual(canonical.metadata, { sessionId: 'sess_1' });
          assert.notStrictEqual(canonical.tools[0], original.tools[0]);
          assert.strictEqual(canonical.tools[0].function.parameters, parameters);
          assert.notStrictEqual(canonical.messages[0], original.messages[0]);
          assert.equal(canonical.messages[0].content, 'hello');
          assert.equal(canonical.messages[1].tool_calls[0].id, 'fc_call_0');
          assert.equal(canonical.messages[1].tool_calls[0].index, undefined);
          assert.equal(canonical.messages[2].tool_call_id, 'fc_call_0');
          assert.equal(canonical.messages[2].id, undefined);
          assert.equal(canonical.messages[2].name, undefined);
          assert.equal(original.providerType, 'openai');
          assert.equal(original.metadata.providerKey, 'internal.provider');
          assert.equal(original.tools[0].function.name, ' tool_a ');
          assert.deepEqual(original.messages[0].content, [{ type: 'text', text: ' hello ' }]);
          assert.deepEqual({ id: original.messages[1].tool_calls[0].id, index: original.messages[1].tool_calls[0].index }, { id: 'call_original', index: 0 });
          assert.deepEqual(original.messages[2], { id: 'tool_msg_id', name: 'tool_a', role: 'tool', tool_call_id: 'call_original', content: ' done ' });
        `
      }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
