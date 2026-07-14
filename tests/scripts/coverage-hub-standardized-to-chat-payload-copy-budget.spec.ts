import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

describe('feature_id: debug.coverage_hub_chat_projection_payload_copy_budget', () => {
  test('standardized-to-chat parity compares materialized outputs without JSON clone graphs', () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-standardized-to-chat-native.mjs'
      ),
      'utf8'
    );

    expect(source).toContain('standardizedToChatEnvelopeWithNative');
    expect(source).toContain('assert.deepEqual(nativeResult, tsResult);');
    expect(source).toContain('assert.deepEqual(nativeResult2, tsResult2);');
    expect(source).not.toContain('JSON.parse(JSON.stringify(value))');
    expect(source).not.toContain('stableJson(');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
  });
});
