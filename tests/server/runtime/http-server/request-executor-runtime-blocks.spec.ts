import { describe, expect, jest, test } from '@jest/globals';
import {
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
        decisionLabel: 'exclude_and_reroute',
        stage: 'provider.send',
        statusCode: 500,
        errorCode: 'HTTP_500',
        upstreamCode: 'HTTP_500',
        backoffMs: 0,
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
        decisionLabel: 'exclude_and_reroute',
        stage: 'provider.send',
        statusCode: 502,
        errorCode: 'PROVIDER_UPSTREAM_TRANSIENT',
        upstreamCode: '13',
        upstreamStatus: 13,
        backoffMs: 0,
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

  test('prints external transport source and compact reason for ECONNRESET provider switches', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logProviderRetrySwitchCompact({
        requestId: 'openai-chat-unknown-unknown-20260629T224935417-424214-4497',
        attempt: 1,
        maxAttempts: 6,
        nextAttempt: 2,
        providerKey: 'orangeai.key1.glm-5.2',
        reason: 'fetch failed',
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'exclude_and_reroute',
        retryExecutionPolicyReason: 'existing_exclusion',
        stage: 'provider.send',
        statusCode: 502,
        errorCode: 'ECONNRESET',
        upstreamCode: 'ECONNRESET',
        providerSwitchLogState: new Map(),
        throttleMs: 5000
      });

      const line = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).find((value) => value.includes('[provider-switch]'));
      expect(line).toContain('status=502');
      expect(line).toContain('code=ECONNRESET');
      expect(line).toContain('upstreamCode=ECONNRESET');
      expect(line).toContain('source=external_transport');
      expect(line).toContain('reason="fetch failed"');
      expect(line).not.toContain('internalCode=');
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

  test('prefers metadata center runtime_control.providerProtocol over flat providerProtocol for responses bypass', () => {
    const metadata: Record<string, unknown> = {
      providerProtocol: 'anthropic-messages'
    };
    const center = new MetadataCenter();
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests/server/runtime/http-server/request-executor-runtime-blocks.spec.ts',
        symbol: 'prefers metadata center runtime_control.providerProtocol over flat providerProtocol for responses bypass',
        stage: 'test'
      }
    );
    MetadataCenter.bind(metadata, center);

    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        id: 'resp_center_truth_bypass',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_center_truth_bypass',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'done'
              }
            ]
          }
        ]
      }
    }, {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      serverToolsEnabled: true,
      metadata
    })).toBe(false);
  });

  test('does not let options.providerProtocol block final responses bypass when metadata center runtime_control.providerProtocol is missing', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        id: 'chatcmpl_no_center_protocol_bypass',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              content: 'done'
            },
            finish_reason: null
          }
        ]
      }
    }, {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      serverToolsEnabled: false,
      metadata: {}
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

  test('does not bypass wrapped sse payloads that still require provider response conversion', () => {
    expect(shouldBypassProviderResponseConversion({
      status: 200,
      body: {
        mode: 'sse',
        clientStream: false,
        payload: {
          object: 'response',
          id: 'resp_wrapped_sse_1',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }]
            }
          ]
        }
      }
    }, {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      serverToolsEnabled: false
    })).toBe(false);
  });
});
