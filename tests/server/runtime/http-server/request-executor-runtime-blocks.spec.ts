import { describe, expect, jest, test } from '@jest/globals';
import {
  logProviderRetrySwitchCompact,
  shouldBypassProviderResponseConversion
} from '../../../../src/server/runtime/http-server/executor/request-executor-runtime-blocks.js';

describe('request-executor-runtime-blocks', () => {
  test('caps attempt counters in provider-switch log when blocking recoverable retries exceed budget', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logProviderRetrySwitchCompact({
        requestId: 'req-fetch-failed-cap',
        attempt: 3,
        maxAttempts: 2,
        nextAttempt: 4,
        providerKey: 'storm.fetch.a',
        reason: 'fetch failed',
        switchAction: 'retry_same_provider',
        backoffScope: 'recoverable',
        decisionLabel: 'recoverable_backoff_same_provider',
        stage: 'provider.send',
        statusCode: 500,
        errorCode: 'HTTP_500',
        upstreamCode: 'HTTP_500',
        backoffMs: 8000,
        providerSwitchLogState: new Map(),
        throttleMs: 5000
      });

      const lines = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(lines.some((line) => line.includes('attempt=2/2 -> 2/2'))).toBe(true);
      expect(lines.some((line) => line.includes('3/2'))).toBe(false);
      expect(lines.some((line) => line.includes('4/2'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('does not bypass provider response conversion for chat.completion business-error bodies', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        object: 'chat.completion',
        choices: null,
        base_resp: {
          status_code: 2056,
          status_msg: 'usage limit exceeded'
        },
        usage: {
          total_tokens: 0
        }
      }
    })).toBe(false);
  });

  test('still bypasses provider response conversion for valid final chat.completion bodies', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
            }
          }
        ]
      }
    })).toBe(true);
  });
});
