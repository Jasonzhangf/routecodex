import { describe, expect, test } from '@jest/globals';
import { sanitizeProviderOutboundPayloadWithNative } from '../../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-policy-semantics.js';

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

  test('converts custom apply_patch into provider function tool for openai-chat transport', () => {
    const output = sanitizeProviderOutboundPayloadWithNative({
      protocol: 'openai-chat',
      payload: {
        model: 'minimax-m3-free',
        messages: [{ role: 'user', content: 'patch' }],
        tools: [{
          type: 'custom',
          name: 'apply_patch',
          description: 'Use the `apply_patch` tool to edit files.',
        }]
      }
    });

    expect(output.tools).toEqual([{
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Use the `apply_patch` tool to edit files.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Workspace-relative target path.'
            },
            patch: {
              type: 'string',
              description: 'Patch payload. Supports line-edit patch, unified diff, or fenced diff block.'
            }
          },
          required: ['filePath', 'patch'],
          additionalProperties: true
        },
        strict: false
      }
    }]);
  });
});
