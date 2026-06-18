import { describe, expect, it } from '@jest/globals';
import {
  detectResponsesFailure,
  extractSubmitToolOutputsPayload
} from '../../../../src/providers/core/runtime/responses-provider-helpers.js';

describe('responses-provider-helpers provider failure policy bridge', () => {
  it('treats 429 responses failure as recoverable and health-neutral', () => {
    const failure = detectResponsesFailure({
      status: 'failed',
      error: {
        code: 'rate_limit_error',
        message: 'Too many requests',
        http_status: 429
      }
    });

    expect(failure).not.toBeNull();
    expect(failure?.recoverable).toBe(true);
    expect(failure?.affectsHealth).toBe(false);
  });

  it('treats auth failure as unrecoverable', () => {
    const failure = detectResponsesFailure({
      status: 'failed',
      error: {
        code: 'unauthorized',
        message: 'invalid access token',
        http_status: 401
      }
    });

    expect(failure).not.toBeNull();
    expect(failure?.recoverable).toBe(false);
    expect(failure?.affectsHealth).toBe(true);
  });

  it('does not reinterpret relay materialized previous_response_id input as native submit_tool_outputs', () => {
    const submit = extractSubmitToolOutputsPayload({
      model: 'gpt-5.5',
      previous_response_id: 'resp_relay_1',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }]
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        },
        {
          type: 'function_call_output',
          id: 'fc_1',
          call_id: 'call_1',
          output: '{"repeatCount":2}'
        }
      ]
    });

    expect(submit).toBeNull();
  });
});
