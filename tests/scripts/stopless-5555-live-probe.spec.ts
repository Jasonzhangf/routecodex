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
});
