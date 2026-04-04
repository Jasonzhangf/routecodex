import { describe, expect, test } from '@jest/globals';

import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../src/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

describe('qwenchat-web compat runtime alias', () => {
  test('request stage reuses deepseek-web text tool request transform', () => {
    const out = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: '请调用工具 exec_command，参数 cmd=pwd' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ],
        tool_choice: 'required'
      } as any,
      explicitProfile: 'chat:qwenchat-web',
      adapterContext: {
        requestId: 'req_qwenchat_web_req_stage',
        providerProtocol: 'openai-chat',
        deepseek: {
          strictToolRequired: true,
          toolProtocol: 'text'
        }
      } as any
    });

    expect(out.appliedProfile).toBe('chat:qwenchat-web');
    expect(typeof (out.payload as any).prompt).toBe('string');
    expect(String((out.payload as any).prompt || '')).toContain('Tool-call output contract');
  });

  test('response stage harvests tool calls under qwenchat profile', () => {
    const out = runRespInboundStage3CompatWithNative({
      payload: {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '<function_calls>{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"pwd"}}]}</function_calls>'
            }
          }
        ]
      } as any,
      explicitProfile: 'chat:qwenchat-web',
      adapterContext: {
        requestId: 'req_qwenchat_web_resp_stage',
        providerProtocol: 'openai-chat',
        deepseek: {
          strictToolRequired: true,
          toolProtocol: 'text'
        },
        capturedChatRequest: {
          tools: [{ function: { name: 'exec_command' } }],
          tool_choice: 'required'
        }
      } as any
    });

    expect(out.appliedProfile).toBe('chat:qwenchat-web');
    expect((out.payload as any).choices[0].finish_reason).toBe('tool_calls');
    expect((out.payload as any).choices[0].message.tool_calls[0].function.name).toBe('exec_command');
  });
});

