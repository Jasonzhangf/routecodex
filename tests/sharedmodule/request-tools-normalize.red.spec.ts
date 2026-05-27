import { describe, expect, test } from '@jest/globals';

import { RequestOpenAIToolsNormalizeFilter } from '../../sharedmodule/llmswitch-core/src/filters/special/request-tools-normalize.js';

describe('request tools normalize regression', () => {
  test('RED: preserves top-level function tool schema instead of degrading to empty parameters', async () => {
    const filter = new RequestOpenAIToolsNormalizeFilter();
    const input: any = {
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: '继续执行' }],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          description: 'run shell command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
              workdir: { type: 'string' }
            },
            required: ['cmd'],
            additionalProperties: false
          }
        }
      ]
    };

    const out = await filter.apply(input as any);
    const tool = (out.data as any).tools?.[0];
    expect(tool?.type).toBe('function');
    expect(tool?.function?.name).toBe('exec_command');
    expect(tool?.function?.parameters).toEqual({
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        workdir: { type: 'string' }
      },
      required: ['cmd'],
      additionalProperties: false
    });
  });
});
