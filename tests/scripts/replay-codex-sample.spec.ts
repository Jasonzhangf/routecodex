import { describe, expect, test } from '@jest/globals';

import { detectSubmitToolOutputsReplayShape, normalizeReplayEndpoint } from '../../scripts/replay-codex-sample.mjs';

describe('replay codex sample endpoint normalization', () => {
  test('RED: provider-request full upstream URL must normalize to local replay path', () => {
    expect(normalizeReplayEndpoint('https://dbittai.com/v1/responses')).toBe('/v1/responses');
  });

  test('keeps existing local path endpoint unchanged', () => {
    expect(normalizeReplayEndpoint('/v1/responses/resp_123/submit_tool_outputs')).toBe(
      '/v1/responses/resp_123/submit_tool_outputs'
    );
  });

  test('preserves query string when upstream URL contains one', () => {
    expect(normalizeReplayEndpoint('https://example.com/v1/responses?foo=1&bar=2')).toBe(
      '/v1/responses?foo=1&bar=2'
    );
  });

  test('RED: provider request with previous_response_id + function_call_output must replay as submit_tool_outputs endpoint', () => {
    const detected = detectSubmitToolOutputsReplayShape(
      {
        previous_response_id: 'resp_submit_123',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_abc',
            output: 'ok'
          }
        ]
      },
      '/v1/responses'
    );

    expect(detected).toEqual({
      endpoint: '/v1/responses/resp_submit_123/submit_tool_outputs',
      body: {
        response_id: 'resp_submit_123',
        tool_outputs: [{ call_id: 'call_abc', output: 'ok' }]
      }
    });
  });
});
