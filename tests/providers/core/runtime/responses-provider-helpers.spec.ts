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
    expect(failure?.affectsHealth).toBe(true);
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

  it('applies provider-configured error mapping to failed responses payload before policy classification', () => {
    const failure = detectResponsesFailure({
      status: 'failed',
      error: {
        code: 'HTTP_400',
        message: 'All available accounts exhausted',
        type: 'server_error',
        param: '',
        http_status: 400
      }
    }, {
      requestId: 'req_responses_failure_mapped',
      providerKey: 'XLC.key2.deepseek-v4-pro',
      providerId: 'XLC',
      extensions: {
        errorMapping: {
          rules: [
            {
              origin: {
                status: 400,
                error: {
                  type: 'server_error',
                  messageContains: 'All available accounts exhausted'
                }
              },
              to: {
                status: 429,
                code: 'HTTP_429',
                message: 'All available accounts exhausted'
              }
            }
          ]
        }
      }
    } as any);

    expect(failure).not.toBeNull();
    expect(failure?.statusCode).toBe(429);
    expect(failure?.code).toBe('HTTP_429');
    expect(failure?.message).toBe('All available accounts exhausted');
    expect(failure?.rawError?.code).toBe('HTTP_429');
    expect(failure?.rawError?.status).toBe(429);
    expect(failure?.recoverable).toBe(true);
  });

  it('treats HTTP 200 text/html stream fallback as malformed provider failure', () => {
    const failure = detectResponsesFailure(
      '<!doctype html><html><body>wrong upstream</body></html>',
      undefined,
      {
        expectedMode: 'sse',
        responseKind: 'text',
        contentType: 'text/html; charset=utf-8',
        statusCode: 200
      }
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe('MALFORMED_RESPONSE');
    expect(failure?.statusCode).toBe(200);
    expect(failure?.recoverable).toBe(true);
    expect(failure?.affectsHealth).toBe(true);
    expect(failure?.message).toContain('HTML instead of SSE');
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
