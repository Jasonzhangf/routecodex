import { describe, expect, test } from '@jest/globals';

import { prepareResponsesRequestBodyForHttp } from '../../src/modules/llmswitch/bridge/responses-request-bridge.ts';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { normalizeResponsesToChatBody } from '../../src/utils/responses-to-chat.js';

describe('responses-to-chat native normalization', () => {
  test('materializes paired Responses function call and output into chat messages', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.4-mini',
      previous_response_id: 'resp_prev',
      input: [
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '/Users/fanzhang/Documents/github/routecodex'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
        }
      ],
      stream: false
    };

    normalizeResponsesToChatBody(body);

    expect(body.input).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(Array.isArray(body.messages)).toBe(true);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))).toBe(true);
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1')).toBe(true);
  });

  test('collapses live stopless continuation tool pair into latest user guidance for responses previous_response_id resume', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      previous_response_id: 'resp_prev_stopless_1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '第一轮 stopless 指令' }]
        },
        {
          type: 'reasoning',
          id: 'reasoning_prev_1',
          summary: [{ type: 'summary_text', text: '**Thinking** 第一轮推理' }]
        },
        {
          type: 'function_call',
          id: 'fc_call_servertool_cli_stopless_1',
          call_id: 'call_servertool_cli_stopless_1',
          name: 'exec_command',
          arguments:
            '{"cmd":"routecodex hook run reasoning_stop --input-json \'{\\"flowId\\":\\"stop_message_flow\\",\\"repeatCount\\":1,\\"maxRepeats\\":3}\'"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_servertool_cli_stopless_1',
          output:
            '{"ok":true,"toolName":"stop_message_auto","flowId":"stop_message_flow","continuationPrompt":"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。","repeatCount":2,"maxRepeats":3}'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
      ],
      stream: false
    };

    normalizeResponsesToChatBody(body);

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('user');
    expect(String(messages[1]?.content ?? '')).toContain('上一轮执行结果：repeatCount=2/3');
    expect(String(messages[1]?.content ?? '')).toContain('继续往下做');
  });

  test('RED: responses-to-chat provider body must materialize stopless guidance text and repeat counter into final messages', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行原任务' }]
        },
        {
          type: 'function_call',
          call_id: 'call_servertool_cli_stop_1',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "routecodex hook run reasoning_stop --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"schemaFeedback\":{\"missingFields\":[\"stopreason\",\"reason\"],\"reasonCode\":\"stop_schema_missing\"},\"triggerHint\":\"no_schema\"}' --repeat-count '1' --max-repeats '3'"
          })
        },
        {
          type: 'function_call_output',
          call_id: 'call_servertool_cli_stop_1',
          output: JSON.stringify({
            ok: true,
            toolName: 'stop_message_auto',
            flowId: 'stop_message_flow',
            repeatCount: 2,
            maxRepeats: 3,
            continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
            schemaFeedback: {
              reasonCode: 'stop_schema_missing',
              missingFields: ['stopreason', 'reason']
            },
            schemaGuidance: {
              requiredFields: ['stopreason', 'reason', 'next_step'],
              stopreasonValues: {
                finished: 0,
                blocked: 1,
                continueNeeded: 2
              },
              triggerHint: 'no_schema'
            }
          })
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
        }
      ],
      stream: false
    };

    normalizeResponsesToChatBody(body);

    const messages = body.messages as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('继续做下一步');
    expect(serialized).toContain('repeatCount=2/3');
    expect(serialized).toContain('reasonCode=stop_schema_missing');
    expect(serialized).toContain('missingFields=stopreason, reason');
    expect(serialized).toContain('如果任务已经完成');
    expect(serialized).toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
  });

  test('RED: stopless guidance must stay co-located in one final user message block instead of only leaking keywords elsewhere', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行原任务' }]
        },
        {
          type: 'function_call',
          call_id: 'call_servertool_cli_stop_2',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "routecodex hook run reasoning_stop --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"schemaFeedback\":{\"missingFields\":[\"stopreason\",\"reason\"],\"reasonCode\":\"stop_schema_missing\"},\"triggerHint\":\"no_schema\"}' --repeat-count '1' --max-repeats '3'"
          })
        },
        {
          type: 'function_call_output',
          call_id: 'call_servertool_cli_stop_2',
          output: JSON.stringify({
            ok: true,
            toolName: 'stop_message_auto',
            flowId: 'stop_message_flow',
            repeatCount: 2,
            maxRepeats: 3,
            continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
            schemaFeedback: {
              reasonCode: 'stop_schema_missing',
              missingFields: ['stopreason', 'reason']
            },
            schemaGuidance: {
              requiredFields: ['stopreason', 'reason', 'next_step'],
              stopreasonValues: {
                finished: 0,
                blocked: 1,
                continueNeeded: 2
              },
              triggerHint: 'no_schema'
            }
          })
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
        }
      ],
      stream: false
    };

    normalizeResponsesToChatBody(body);

    const messages = (body.messages as Array<Record<string, unknown>>).filter((message) => message.role === 'user');
    const matched = messages.find((message) => {
      const text = String(message.content ?? '');
      return text.includes('repeatCount=2/3')
        && text.includes('reasonCode=stop_schema_missing')
        && text.includes('missingFields=stopreason, reason')
        && text.includes('如果任务已经完成')
        && text.includes('stopreason 取值：0=finished，1=blocked，2=continue_needed');
    });
    expect(matched).toBeDefined();
  });

  test('materializes MetadataCenter stopless control through responses instructions into final provider messages', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行原任务' }]
        }
      ],
      stream: false
    };

    const runtimeMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(runtimeMetadata);
    center.writeRuntimeControl(
      'stopless',
      {
        sessionId: 'sess-stopless-provider-blackbox-1',
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        schemaFeedback: {
          reasonCode: 'stop_schema_missing',
          missingFields: ['stopreason', 'reason']
        },
        active: true,
        updatedAt: 123
      },
      {
        module: 'tests/utils/responses-to-chat-native.spec.ts',
        symbol: 'materializes MetadataCenter stopless control through responses instructions into final provider messages',
        stage: 'test'
      }
    );

    const prepared = prepareResponsesRequestBodyForHttp(body, runtimeMetadata);
    normalizeResponsesToChatBody(prepared.pipelineBody);

    const messages = prepared.pipelineBody.messages as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('继续做下一步');
    expect(serialized).toContain('repeatCount=2/3');
    expect(serialized).toContain('reasonCode=stop_schema_missing');
    expect(serialized).toContain('missingFields=stopreason, reason');
    expect(serialized).toContain('如果任务已经完成');
    expect(serialized).toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
  });

  test('keeps existing chat messages when provider body already materialized messages and only instructions remain', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: '继续执行当前任务' }
      ],
      instructions: '如果任务完成，按要求收尾；否则继续执行。',
      stream: true
    };

    normalizeResponsesToChatBody(body);

    expect(body.input).toBeUndefined();
    expect(body.instructions).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: '如果任务完成，按要求收尾；否则继续执行。' },
      { role: 'user', content: '继续执行当前任务' }
    ]);
  });
});
