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
      name: 'spawn_agent',
      description: 'spawn',
      parameters: { type: 'object' }
    }]);
    expect(output.tools[0]).not.toHaveProperty('function');
  });

  test('keeps OpenAI Responses function tools in flat Responses wire shape', () => {
    const output = sanitizeProviderOutboundPayloadWithNative({
      protocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        tools: [{
          type: 'function',
          name: 'exec_command',
          description: 'Run a command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
          strict: false
        }]
      }
    });

    expect(output.tools).toEqual([{
      type: 'function',
      name: 'exec_command',
      description: 'Run a command',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
      strict: false
    }]);
    expect(output.tools[0]).not.toHaveProperty('function');
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
            patch: {
              type: 'string',
              description: 'Raw apply_patch text. Send canonical *** Begin Patch / *** End Patch grammar as a single string. Put workspace-relative paths inside patch headers such as *** Add File: tmp/example.txt or *** Update File: src/main.ts. For temporary tests, use tmp/... inside the workspace, not /tmp/.... Do not use absolute paths.'
            }
          },
          required: ['patch'],
          additionalProperties: true
        },
        strict: false
      }
    }]);
  });
});
