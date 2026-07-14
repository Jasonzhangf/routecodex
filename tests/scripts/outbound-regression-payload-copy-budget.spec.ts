import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  cloneOutboundRegressionExecutionPayload
} from '../../scripts/outbound-regression-codex-samples.mjs';

describe('feature_id: debug.outbound_regression_payload_copy_budget', () => {
  test('source keeps one structured clone owner and rejects fallback clone paths', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/outbound-regression-codex-samples.mjs'),
      'utf8'
    );

    expect(source).toContain('structuredClone(value)');
    expect(source).not.toContain('JSON.parse(JSON.stringify');
    expect(source).not.toContain('catch { return obj; }');
    expect(source).toContain("import.meta.url === pathToFileURL(process.argv[1]).href");
  });

  test('creates one independent execution graph with structured-clone semantics', () => {
    const source: Record<string, unknown> = {
      value: 7n,
      optional: undefined,
      nested: { tool: 'add' }
    };
    source.self = source;

    const cloned = cloneOutboundRegressionExecutionPayload(source);

    expect(cloned).not.toBe(source);
    expect(cloned.nested).not.toBe(source.nested);
    expect(cloned.value).toBe(7n);
    expect(Object.prototype.hasOwnProperty.call(cloned, 'optional')).toBe(true);
    expect(cloned.self).toBe(cloned);
  });

  test('provider-side mutation cannot change the caller-owned regression request', () => {
    const source = {
      messages: [{ role: 'user', content: 'call add' }],
      tools: [{ type: 'function', function: { name: 'add' } }]
    };

    const cloned = cloneOutboundRegressionExecutionPayload(source);
    cloned.messages[0].content = 'mutated by provider';
    cloned.tools[0].function.name = 'other';

    expect(source.messages[0].content).toBe('call add');
    expect(source.tools[0].function.name).toBe('add');
  });
});
