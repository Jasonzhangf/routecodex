import { describe, expect, jest, test } from '@jest/globals';
import {
  isServerToolFollowupRequest,
  logProviderRetrySwitchCompact,
  shouldBypassProviderResponseConversion
} from '../../../../src/server/runtime/http-server/executor/request-executor-runtime-blocks.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

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
        switchAction: 'exclude_and_reroute',
        backoffScope: 'provider',
        decisionLabel: 'provider_backoff_then_reroute',
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

  test('logs upstreamStatus separately from HTTP status in provider-switch line', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logProviderRetrySwitchCompact({
        requestId: 'req-provider-upstream-code',
        attempt: 1,
        maxAttempts: 6,
        nextAttempt: 2,
        providerKey: 'openai.key3.gpt-5.4-none',
        reason: 'An internal error occurred (error ID: upstream-13)',
        switchAction: 'exclude_and_reroute',
        backoffScope: 'provider',
        decisionLabel: 'provider_backoff_then_reroute',
        stage: 'provider.send',
        statusCode: 502,
        errorCode: 'PROVIDER_UPSTREAM_TRANSIENT',
        upstreamCode: '13',
        upstreamStatus: 13,
        backoffMs: 2000,
        providerSwitchLogState: new Map(),
        throttleMs: 5000
      });

      const line = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).find((value) => value.includes('[provider-switch]'));
      expect(line).toContain('status=502');
      expect(line).toContain('upstreamCode=13');
      expect(line).toContain('upstreamStatus=13');
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

  test('allows final response bypass for apply_patch tool_calls despite legacy servertool metadata', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_patch',
                  type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: JSON.stringify({ filePath: 'a.txt', patch: '+ hello' })
                  }
                }
              ]
            }
          }
        ]
      }
    }, {
      metadata: { __rt: { applyPatch: { mode: 'servertool' } } },
      serverToolsEnabled: true
    })).toBe(true);
  });

  test('does not bypass cross-protocol completed responses bodies on /v1/responses when stopless is enabled', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '阶段完成' }]
          }
        ],
        output_text: '阶段完成'
      }
    }, {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      serverToolsEnabled: true
    })).toBe(false);
  });

  test('still bypasses cross-protocol completed responses bodies on /v1/responses when stopless is disabled', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '阶段完成' }]
          }
        ],
        output_text: '阶段完成'
      }
    }, {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      serverToolsEnabled: false
    })).toBe(true);
  });

  test('reads servertool followup request truth from MetadataCenter runtime_control', () => {
    const metadata: Record<string, unknown> = {};
    MetadataCenter.attach(metadata).writeRuntimeControl(
      'serverToolFollowup',
      true,
      {
        module: 'tests/server/runtime/http-server/request-executor-runtime-blocks.spec.ts',
        symbol: 'reads servertool followup request truth from MetadataCenter runtime_control',
        stage: 'test'
      }
    );

    expect(isServerToolFollowupRequest(metadata)).toBe(true);
  });

  test('does not revive servertool followup request truth from legacy __rt fallback', () => {
    const metadata: Record<string, unknown> = {
      __rt: { serverToolFollowup: true }
    };

    expect(isServerToolFollowupRequest(metadata)).toBe(false);
  });
});
