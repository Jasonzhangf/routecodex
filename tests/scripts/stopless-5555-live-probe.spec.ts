import { describe, expect, test } from '@jest/globals';

import {
  materializeProbeResponseBody,
  summarizeAttempt
} from '../../scripts/tests/stopless-5555-live-probe.mjs';

describe('stopless live probe SSE closeout parsing', () => {
  test('RED: submit_tool_outputs SSE completion must materialize completed response status', () => {
    const raw = [
      ': keepalive',
      '',
      'event: response.created',
      'data: {"response":{"id":"resp_probe_1","status":"in_progress","output":[],"model":"gpt-5.5","object":"response","created_at":1},"type":"response.created"}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_probe_1","status":"completed","output":[{"id":"message_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"## 完成内容\\n- 结论: 已完成两轮 stopless 恢复验证"}]}],"model":"gpt-5.5","object":"response","created_at":1},"type":"response.completed"}',
      ''
    ].join('\n');

    expect(materializeProbeResponseBody({ raw })).toMatchObject({
      id: 'resp_probe_1',
      status: 'completed'
    });
  });

  test('summarizeAttempt reads final completed status and assistant text from raw SSE body', () => {
    const raw = [
      ': keepalive',
      '',
      'event: response.created',
      'data: {"response":{"id":"resp_probe_2","status":"in_progress","output":[],"model":"gpt-5.5","object":"response","created_at":1},"type":"response.created"}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_probe_2","status":"completed","output":[{"id":"message_2","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"## 完成内容\\n- 证据: 5555 live submit_tool_outputs"}]}],"model":"gpt-5.5","object":"response","created_at":1},"type":"response.completed"}',
      ''
    ].join('\n');

    const summary = summarizeAttempt('submit_tool_outputs', 1, {
      status: 200,
      body: { raw }
    });

    expect(summary.responseId).toBe('resp_probe_2');
    expect(summary.responseStatus).toBe('completed');
    expect(summary.hasExecCommand).toBe(false);
    expect(summary.outputText).toContain('5555 live submit_tool_outputs');
  });

  test('summarizeAttempt recognizes proactive reasoning.stop required_action as live stopless path', () => {
    const summary = summarizeAttempt('gpt-5.5', 1, {
      status: 200,
      body: {
        id: 'resp_reasoning_stop_1',
        status: 'requires_action',
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_reasoning_stop_1',
                tool_call_id: 'call_reasoning_stop_1',
                type: 'function',
                name: 'reasoning.stop',
                function: {
                  name: 'reasoning.stop',
                  arguments: '{"stopreason":"2","reason":"first round"}'
                }
              }
            ]
          }
        }
      }
    });

    expect(summary.responseStatus).toBe('requires_action');
    expect(summary.hasExecCommand).toBe(false);
    expect(summary.hasReasoningStop).toBe(true);
    expect(summary.reasoningStopToolCallId).toBe('call_reasoning_stop_1');
    expect(summary.reasoningStopArguments).toContain('"stopreason":"2"');
  });

  test('completed continuation is not accepted when stop schema leaked as plain text', () => {
    const summary = summarizeAttempt('submit_tool_outputs', 2, {
      status: 200,
      body: {
        id: 'resp_leaked_stop_schema',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '{"stopreason":2,"reason":"继续推进"}'
              }
            ]
          }
        ]
      }
    });

    expect(summary.responseStatus).toBe('completed');
    expect(summary.hasExecCommand).toBe(false);
    expect(summary.leakedStopSchema).toBe(true);
  });
});
