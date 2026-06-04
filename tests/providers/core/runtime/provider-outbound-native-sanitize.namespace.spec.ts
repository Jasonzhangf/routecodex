import { describe, expect, test } from '@jest/globals';
import { sanitizeProviderOutboundPayloadWithNative } from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-policy-semantics.js';

describe('provider outbound native sanitize namespace guard', () => {
  test('flattens namespace tool aggregate before provider transport', () => {
    const output = sanitizeProviderOutboundPayloadWithNative({
      protocol: 'openai-responses',
      payload: {
        model: 'minimax-m3-free',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        tools: [{
          type: 'namespace',
          name: 'multi_agent_v1',
          tools: [{ type: 'function', name: 'spawn_agent', description: 'spawn', parameters: { type: 'object' } }]
        }]
      }
    });

    expect(output.tools).toEqual([{
      type: 'function',
      function: {
        name: 'spawn_agent',
        description: 'spawn',
        parameters: { type: 'object' }
      }
    }]);
  });
});
