import { describe, expect, it } from '@jest/globals';

import { runReqInboundStage2SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.js';
import type { StageRecorder } from '../../sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.js';

describe('req inbound stage2 tool shape normalization', () => {
  it('normalizes shell-like and apply_patch tool calls before stage2 record/standardize', async () => {
    const recorded: Array<{ stage: string; payload: any }> = [];
    const stageRecorder: StageRecorder = {
      record(stage, payload) {
        recorded.push({ stage, payload });
      }
    };

    const adapterContext = {
      requestId: 'req-stage2-tool-shape',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const stage2 = await runReqInboundStage2SemanticMap({
      adapterContext: adapterContext as any,
      formatEnvelope: {
        protocol: 'openai-chat',
        direction: 'request',
        payload: {
          model: 'glm-5',
          messages: [{ role: 'user', content: 'continue' }],
          tools: [
            { type: 'function', function: { name: 'exec_command' } },
            { type: 'function', function: { name: 'apply_patch' } }
          ]
        }
      } as any,
      semanticMapper: {
        async toChat() {
          return {
            messages: [
              { role: 'user', content: 'continue' },
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_exec_1',
                    type: 'function',
                    function: {
                      name: 'exec_command',
                      arguments: JSON.stringify({
                        args: { command: 'git status --short' },
                        cwd: '/workspace/repo'
                      })
                    }
                  },
                  {
                    id: 'call_patch_1',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({
                        input: '*** note.txt\n--- note.txt\n@@ -0,0 +1 @@\n+hello'
                      })
                    }
                  }
                ]
              }
            ],
            tools: [
              { type: 'function', function: { name: 'exec_command' } },
              { type: 'function', function: { name: 'apply_patch' } }
            ],
            parameters: { model: 'glm-5' },
            metadata: { context: adapterContext }
          } as any;
        }
      },
      stageRecorder
    });

    const assistantMessage = (stage2.chatEnvelope.messages as any[])[1];
    const standardizedAssistantMessage = (stage2.standardizedRequest.messages as any[])[1];
    const recordedStage = recorded.find((entry) => entry.stage === 'chat_process.req.stage2.semantic_map');

    expect(recordedStage).toBeDefined();

    const execArgsText = assistantMessage.tool_calls[0].function.arguments;
    const execArgs = JSON.parse(execArgsText);
    expect(execArgs.cmd).toBe('git status --short');
    expect(execArgs.command).toBe('git status --short');
    expect(execArgs.workdir).toBe('/workspace/repo');

    const patchArgsText = assistantMessage.tool_calls[1].function.arguments;
    const patchArgs = JSON.parse(patchArgsText);
    expect(patchArgs.input).toContain('*** Begin Patch');
    expect(patchArgs.input).toContain('*** Update File: note.txt');

    expect(JSON.parse(standardizedAssistantMessage.tool_calls[0].function.arguments).cmd).toBe(
      'git status --short'
    );
    expect(JSON.parse(standardizedAssistantMessage.tool_calls[1].function.arguments).input).toContain(
      '*** Begin Patch'
    );

    expect(
      JSON.parse(recordedStage!.payload.messages[1].tool_calls[0].function.arguments).cmd
    ).toBe('git status --short');
    expect(
      JSON.parse(recordedStage!.payload.messages[1].tool_calls[1].function.arguments).input
    ).toContain('*** Begin Patch');
  });
});
