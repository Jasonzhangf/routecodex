import { describe, expect, it } from '@jest/globals';

import { buildClientPayloadForProtocol } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/client-remap-protocol-switch.js';
import { mapChatToolsToAnthropicTools } from '../../sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils.js';
import { validateChatEnvelopeWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

function buildCodexLikeToolList(): Array<Record<string, unknown>> {
  const functionTool = (name: string) => ({
    type: 'function',
    function: {
      name,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  });

  return [
    functionTool('exec_command'),
    functionTool('write_stdin'),
    functionTool('apply_patch'),
    functionTool('update_plan'),
    functionTool('view_image'),
    functionTool('web_search'),
    functionTool('clock'),
    functionTool('shell'),
    functionTool('read'),
    functionTool('grep'),
    functionTool('find'),
    functionTool('list_dir'),
    functionTool('open_file'),
    functionTool('search_code'),
    {
      type: 'namespace',
      name: 'mcp__computer_use__',
      description: 'Computer Use tools',
      tools: [
        {
          type: 'function',
          name: 'get_app_state',
          description: 'Inspect app state',
          defer_loading: true,
          parameters: {
            type: 'object',
            properties: {
              app: { type: 'string' }
            },
            required: ['app'],
            additionalProperties: false
          }
        },
        {
          type: 'function',
          name: 'click',
          description: 'Click element',
          parameters: {
            type: 'object',
            properties: {
              app: { type: 'string' },
              element_index: { type: 'string' }
            },
            required: ['app'],
            additionalProperties: false
          }
        }
      ]
    }
  ];
}

describe('computer use namespace contract', () => {
  it('accepts a realistic codex mixed tool list with namespace tool at index 14', () => {
    const envelope = {
      messages: [{ role: 'user', content: 'inspect Chrome' }],
      parameters: { model: 'gpt-5-codex' },
      metadata: { context: { entryEndpoint: '/v1/responses' } },
      tools: buildCodexLikeToolList()
    } as Record<string, unknown>;

    expect(() =>
      validateChatEnvelopeWithNative(envelope, {
        stage: 'req_inbound',
        direction: 'request'
      })
    ).not.toThrow();
  });

  it('flattens namespace child tools for anthropic function-only outbound contracts', () => {
    const anthropicTools = mapChatToolsToAnthropicTools(buildCodexLikeToolList() as any[]) as Array<Record<string, unknown>>;

    expect(Array.isArray(anthropicTools)).toBe(true);
    expect(anthropicTools.some((tool) => tool.name === 'mcp__computer_use__get_app_state')).toBe(true);
    expect(anthropicTools.some((tool) => tool.name === 'mcp__computer_use__click')).toBe(true);
    expect(anthropicTools.some((tool) => tool.name === 'mcp__computer_use__')).toBe(false);
    const stateTool = anthropicTools.find((tool) => tool.name === 'mcp__computer_use__get_app_state') as Record<string, any> | undefined;
    expect(stateTool?.input_schema?.properties?.app?.type).toBe('string');
  });

  it('remaps flattened computer-use tool calls back to responses namespace shape', () => {
    const result = buildClientPayloadForProtocol({
      payload: {
        id: 'resp_ns_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'mcp__computer_use__get_app_state',
            arguments: '{"app":"Google Chrome"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                name: 'mcp__computer_use__get_app_state',
                arguments: '{"app":"Google Chrome"}'
              }
            ]
          }
        }
      } as any,
      clientProtocol: 'openai-responses',
      requestId: 'req_namespace_resp_1',
      requestSemantics: {
        tools: {
          clientToolsRaw: buildCodexLikeToolList()
        }
      } as any
    });

    expect((result as any)?.status).toBe('requires_action');
    expect((result as any)?.output?.[0]).toMatchObject({
      type: 'function_call',
      name: 'get_app_state',
      namespace: 'mcp__computer_use__',
      arguments: '{"app":"Google Chrome"}'
    });
    expect((result as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0]).toMatchObject({
      type: 'function',
      name: 'get_app_state',
      namespace: 'mcp__computer_use__',
      arguments: '{"app":"Google Chrome"}'
    });
  });

});
