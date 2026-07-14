import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

describe('feature_id: debug.coverage_hub_standardized_payload_copy_budget', () => {
  test('coverage helper compares parity output without JSON round-trip object clones', () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-envelope-to-standardized-native.mjs'
      ),
      'utf8'
    );

    expect(source).toContain('chatEnvelopeToStandardizedWithNative');
    expect(source).not.toContain('JSON.parse(JSON.stringify(value))');
    expect(source).not.toContain('stableJson(');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
  });
});
