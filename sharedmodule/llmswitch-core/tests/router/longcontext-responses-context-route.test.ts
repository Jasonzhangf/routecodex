import { describe, expect, test } from '@jest/globals';

import { RoutingClassifier } from '../../src/router/virtual-router/classifier.js';
import { buildRoutingFeatures } from '../../src/router/virtual-router/features.js';

describe('virtual-router longcontext detection from responses context', () => {
  test('classifies oversized responses context input as longcontext before tool continuation', () => {
    const largeOutput = Array.from(
      { length: 220 },
      (_, index) => `step_${index} alpha beta gamma delta epsilon zeta eta theta`
    ).join('\n');
    const req = {
      model: 'gpt-test',
      messages: [{ role: 'assistant', content: 'followup' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      semantics: {
        responses: {
          context: {
            input: Array.from({ length: 280 }, (_, index) => ({
              type: 'function_call_output',
              call_id: `call_${index}`,
              output: largeOutput
            }))
          }
        }
      }
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_longcontext' } as any);
    expect(features.estimatedTokens).toBeGreaterThanOrEqual(180000);

    const classifier = new RoutingClassifier({});
    const result = classifier.classify(features);
    expect(result.routeName).toBe('longcontext');
    expect(result.reasoning).toContain('longcontext:token-threshold');
  });
});
