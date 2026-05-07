import { describe, expect, test } from '@jest/globals';

import { prepareReasoningStopRequestTooling } from '../../src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.js';

describe('prepareReasoningStopRequestTooling', () => {
  test('preserves original capturedChatRequest during serverTool followup reentry', () => {
    const originalCaptured: any = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '原始用户请求' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        },
        {
          type: 'function',
          function: {
            name: 'write_stdin',
            parameters: { type: 'object', properties: { session_id: { type: 'number' } } }
          }
        }
      ],
      parameters: {
        parallel_tool_calls: true
      }
    };

    const request: any = {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: '继续执行，不要停止' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'reasoning.stop',
            parameters: { type: 'object', properties: { task_goal: { type: 'string' } } }
          }
        }
      ],
      parameters: {}
    };

    const adapterContext: any = {
      capturedChatRequest: JSON.parse(JSON.stringify(originalCaptured)),
      __rt: {
        serverToolFollowup: true
      }
    };

    prepareReasoningStopRequestTooling({
      request,
      adapterContext
    });

    expect(adapterContext.capturedChatRequest).toEqual(originalCaptured);
    expect(request.messages).toEqual([{ role: 'user', content: '继续执行，不要停止' }]);
    expect((request.tools as any[]).map((tool) => tool?.function?.name)).toEqual(['reasoning.stop']);
  });

  test('captures current request on non-followup entry and appends reasoning.stop to captured tools', () => {
    const request: any = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '检查日志' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {
        parallel_tool_calls: true
      }
    };

    const adapterContext: any = {};

    prepareReasoningStopRequestTooling({
      request,
      adapterContext
    });

    expect(Array.isArray(adapterContext.capturedChatRequest?.messages)).toBe(true);
    expect(
      (adapterContext.capturedChatRequest.tools as any[]).map((tool) => tool?.function?.name)
    ).toEqual(['exec_command', 'reasoning.stop']);
    expect((request.tools as any[]).map((tool) => tool?.function?.name)).toEqual([
      'exec_command',
      'reasoning.stop'
    ]);
  });
});
