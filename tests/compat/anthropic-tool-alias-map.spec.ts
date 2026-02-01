import { describe, expect, it } from '@jest/globals';
import { runReqInboundStage2SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';

describe('anthropic-messages tool alias remap', () => {
  it('captures toolNameAliasMap from raw /v1/messages tools and remaps tool_use names', async () => {
    const tools = [
      {
        name: 'Bash',
        description: 'Run a shell command.',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
          additionalProperties: false
        }
      },
      {
        name: 'Glob',
        description: 'Match files by glob pattern.',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern'],
          additionalProperties: false
        }
      },
      {
        name: 'Grep',
        description: 'Search text in files.',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern'],
          additionalProperties: false
        }
      },
      {
        name: 'Read',
        description: 'Read a file by path.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false
        }
      },
      {
        name: 'Task',
        description: 'Spawn a sub-agent.',
        input_schema: {
          type: 'object',
          properties: { subagent_type: { type: 'string' } },
          required: ['subagent_type'],
          additionalProperties: false
        }
      }
    ];

    const adapterContext = {
      requestId: 'req_test',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    };

    const formatEnvelope = {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: {
        model: 'glm-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        tools
      }
    };

    const stage2 = await runReqInboundStage2SemanticMap({
      adapterContext: adapterContext as any,
      formatEnvelope: formatEnvelope as any,
      semanticMapper: {
        async toChat() {
          return {
            messages: [{ role: 'user', content: 'hi' }],
            parameters: { model: 'glm-4.6' },
            metadata: { context: adapterContext }
          } as any;
        }
      },
      stageRecorder: undefined
    });

    const semantics = (stage2.standardizedRequest as any).semantics;
    const aliasMap = semantics?.tools?.toolNameAliasMap;
    expect(aliasMap).toBeDefined();
    expect(aliasMap.shell_command).toBe('Bash');
    expect(aliasMap.glob).toBe('Glob');
    expect(aliasMap.grep).toBe('Grep');
    expect(aliasMap.read).toBe('Read');
    expect(aliasMap.task).toBe('Task');

    const chatResponse = {
      id: 'chatcmpl_test',
      model: 'glm-4.6',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_shell',
                type: 'function',
                function: { name: 'shell_command', arguments: '{"cmd":"ls"}' }
              },
              {
                id: 'call_glob',
                type: 'function',
                function: { name: 'glob', arguments: '{"pattern":"**/*.ts"}' }
              },
              {
                id: 'call_grep',
                type: 'function',
                function: { name: 'grep', arguments: '{"pattern":"TODO"}' }
              },
              {
                id: 'call_read',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"README.md"}' }
              },
              {
                id: 'call_task',
                type: 'function',
                function: { name: 'task', arguments: '{"subagent_type":"general-purpose"}' }
              }
            ]
          }
        }
      ]
    };

    const clientPayload = runRespOutboundStage1ClientRemap({
      payload: chatResponse as any,
      clientProtocol: 'anthropic-messages',
      requestId: 'req_test',
      requestSemantics: semantics
    }) as any;

    const toolUseNames = (clientPayload.content as any[])
      .filter((b) => b && b.type === 'tool_use')
      .map((b) => b.name);

    expect(toolUseNames).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'Task']);
  });

  it('falls back to clientToolsRaw when toolNameAliasMap is missing', () => {
    const semantics = {
      tools: {
        clientToolsRaw: [
          { name: 'Bash', description: 'Run a shell command.', input_schema: { type: 'object' } },
          { name: 'Glob', description: 'Match files.', input_schema: { type: 'object' } }
        ]
      }
    };

    const chatResponse = {
      id: 'chatcmpl_test',
      model: 'glm-4.6',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_shell', type: 'function', function: { name: 'shell_command', arguments: '{"cmd":"ls"}' } },
              { id: 'call_glob', type: 'function', function: { name: 'glob', arguments: '{"pattern":"**/*.ts"}' } }
            ]
          }
        }
      ]
    };

    const clientPayload = runRespOutboundStage1ClientRemap({
      payload: chatResponse as any,
      clientProtocol: 'anthropic-messages',
      requestId: 'req_test',
      requestSemantics: semantics as any
    }) as any;

    const toolUseNames = (clientPayload.content as any[])
      .filter((b) => b && b.type === 'tool_use')
      .map((b) => b.name);

    expect(toolUseNames).toEqual(['Bash', 'Glob']);
  });
});
