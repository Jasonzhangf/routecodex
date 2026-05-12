import { describe, expect, it } from '@jest/globals';

import { runRespProcessStage1ToolGovernance } from '../index.js';
import { buildOpenAIChatFromAnthropicMessage } from '../../../../../response/response-runtime.js';

function createStageRecorder(target: Array<{ stage: string; payload: Record<string, unknown> }>) {
  return {
    record(stage: string, payload: object) {
      target.push({ stage, payload: payload as Record<string, unknown> });
    }
  };
}

describe('resp-process-stage1-tool-governance native wrapper', () => {
  it('normalizes non-canonical responses payload but does not infer tool calls from raw bash inside wrapper', async () => {
    const stageRecords: Array<{ stage: string; payload: Record<string, unknown> }> = [];

    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp_stage1_wrapper',
        model: 'gpt-test',
        status: 'completed',
        output_text: '<function_calls>```bash\npwd\n```</function_calls>',
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-wrapper',
      clientProtocol: 'openai-responses',
      stageRecorder: createStageRecorder(stageRecords)
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls ?? []).toHaveLength(0);
    expect(result.governedPayload.choices?.[0]?.message?.content ?? '').toBe('```bash\npwd\n```');

    const canonicalizeRecord = stageRecords.find(
      (entry) => entry.stage === 'chat_process.resp.stage6.canonicalize_chat_completion'
    );
    expect(canonicalizeRecord?.payload).toMatchObject({
      converted: true,
      shapeSanitized: true,
      harvestedToolCalls: 0
    });
    expect(
      (canonicalizeRecord?.payload.canonicalPayload as any)?.choices?.[0]?.message?.tool_calls ?? []
    ).toHaveLength(0);
    expect(
      (canonicalizeRecord?.payload.canonicalPayload as any)?.choices?.[0]?.message?.content ?? ''
    ).toBe('```bash\npwd\n```');
  });
  it('drops harvested tool calls when the name is outside the current request tool list', async () => {
    const outputText = [
      '<function_calls>```bash',
      'pwd',
      '```</function_calls>',
      '保留正文'
    ].join('\n');

    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp_stage1_wrapper_allowlist',
        model: 'gpt-test',
        status: 'completed',
        output_text: outputText,
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-wrapper-allowlist',
      clientProtocol: 'openai-responses',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                parameters: {
                  type: 'object',
                  properties: {
                    patch: { type: 'string' }
                  },
                  required: ['patch'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls ?? []).toHaveLength(0);
    expect(result.governedPayload.choices?.[0]?.finish_reason).toBe('stop');
    expect(String(result.governedPayload.choices?.[0]?.message?.content ?? '')).toContain('保留正文');
  });

  it('harvests DSML transcript wrapper with right gutter noise without leaking markup', async () => {
    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        choices: [{
          message: {
            tool_calls: [],
            content: [
              '• Ran tool transcript',
              '                                                                                │·······························',
              '└ <DSML|tool_calls>                                                             │·······························',
              '  <DSML|invoke name="view_image">                                              │·······························',
              '  <DSML|parameter name="path">[Image #1]</DSML|parameter>                      │·······························',
              '  </DSML|invoke>                                                                │·······························',
              '  </DSML|tool_calls>                                                            │·······························',
              '                                                                                │·······························',
              '› Summarize recent commits                                                      │·······························'
            ].join('\n')
          },
          finish_reason: 'stop'
        }],
        __rcc_tool_governance: {
          requestedToolNames: ['view_image'],
          providerFamily: 'deepseek-web'
        }
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-dsml-ran-transcript',
      clientProtocol: 'openai-responses'
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls ?? []).toHaveLength(1);
    expect(result.governedPayload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('view_image');
    expect(result.governedPayload.choices?.[0]?.finish_reason).toBe('tool_calls');
    const content = String(result.governedPayload.choices?.[0]?.message?.content ?? '');
    expect(content.includes('DSML')).toBe(false);
    expect(content.includes('tool transcript')).toBe(false);
    expect(content.includes('Summarize recent commits')).toBe(false);
  });

  it('does not fail fast on unharvested explicit wrapper and keeps cleaned inner text for next round', async () => {
    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        choices: [{
          message: {
            tool_calls: [],
            content: '<function_calls>{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}}]}</function_calls>'
          },
          finish_reason: 'stop'
        }],
        __rcc_tool_governance: {
          requestedToolNames: ['exec_command']
        }
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-unharvested-wrapper-continue',
      clientProtocol: 'openai-responses'
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls ?? []).toHaveLength(0);
    expect(result.governedPayload.choices?.[0]?.finish_reason).toBe('stop');
    const content = String(result.governedPayload.choices?.[0]?.message?.content ?? '');
    expect(content.includes('<function_calls>')).toBe(false);
    expect(content.includes('</function_calls>')).toBe(false);
  });

  it('preserves anthropic tool_use exec_command on reasoning_stop_continue followup when requestSemantics carries original client tools', async () => {
    const anthropicPayload = {
      id: 'msg_reasoning_stop_continue_sample',
      type: 'message',
      role: 'assistant',
      model: 'mimo-v2.5-pro',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'thinking',
          signature: 'sig_1',
          thinking: 'Let me check the current state of processes and logs.'
        },
        {
          type: 'tool_use',
          id: 'call_2587a3ec32234b1da06bc8fe',
          name: 'exec_command',
          input: {
            cmd: "bash -lc 'date; echo \"=== Process Status ===\"; ps aux | grep -E \"(fin daemon-run|qqbot-peer-runner|fin web-debug)\" | grep -v grep'"
          }
        }
      ]
    } as any;

    const mappedPayload = buildOpenAIChatFromAnthropicMessage(anthropicPayload, {
      includeToolCallIds: true
    }) as any;
    expect(mappedPayload?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');

    const result = await runRespProcessStage1ToolGovernance({
      payload: mappedPayload,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-reasoning-stop-continue-semantics',
      clientProtocol: 'openai-responses',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                parameters: {
                  type: 'object',
                  properties: {
                    cmd: { type: 'string' }
                  },
                  required: ['cmd']
                }
              }
            }
          ]
        }
      } as any,
      adapterContext: {
        capturedChatRequest: {
          tools: [
            {
              type: 'function',
              function: {
                name: 'reasoning.stop',
                parameters: { type: 'object' }
              }
            }
          ]
        }
      }
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls).toHaveLength(1);
    expect(result.governedPayload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    expect(result.governedPayload.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe('call_2587a3ec32234b1da06bc8fe');
    expect(result.governedPayload.choices?.[0]?.finish_reason).toBe('tool_calls');
  });
});
