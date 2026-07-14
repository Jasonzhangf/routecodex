import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import {
  buildReplayInputFromProviderRequest,
  detectSubmitToolOutputsReplayShape,
  extractSampleHeaders,
  normalizeReplayEndpoint,
  stripReplayOnlyClientHeadersFromBody
} from '../../scripts/replay-codex-sample.mjs';

describe('feature_id: debug.replay_codex_sample_payload_copy_budget', () => {
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

  test('extracts replay headers from nested request body clientHeaders when top-level headers are absent', () => {
    expect(
      extractSampleHeaders({
        body: {
          metadata: {
            clientHeaders: {
              session_id: 'sess_nested_1',
              conversation_id: 'conv_nested_1',
              'user-agent': 'codex-tui/0.128.0'
            }
          }
        }
      })
    ).toEqual({
      session_id: 'sess_nested_1',
      conversation_id: 'conv_nested_1',
      'user-agent': 'codex-tui/0.128.0'
    });
  });

  test('strips replay-only clientHeaders from request body metadata before dispatch', () => {
    expect(
      stripReplayOnlyClientHeadersFromBody({
        metadata: {
          clientHeaders: {
            session_id: 'sess_nested_2'
          },
          rcc_passthrough_tool_choice: 'auto',
          routeHint: 'search'
        }
      })
    ).toEqual({});
  });

  test('payload copy budget: source rejects replay JSON round-trip clones', () => {
    const source = readFileSync(new URL('../../scripts/replay-codex-sample.mjs', import.meta.url), 'utf8');

    expect(source).not.toContain('JSON.parse(JSON.stringify(body))');
  });

  test('payload copy budget: metadata stripping shallow-copies only rewritten owners', () => {
    const input = {
      model: 'gpt-test',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      tools: [{ type: 'function', name: 'tool_a', parameters: { type: 'object' } }],
      metadata: {
        clientHeaders: { session_id: 'sess_1' },
        sessionId: 'sess_1',
        routeHint: 'drop-me'
      },
      extension: { keep: true }
    };

    const result = stripReplayOnlyClientHeadersFromBody(input);

    expect(result).not.toBe(input);
    expect(result.input).toBe(input.input);
    expect(result.tools).toBe(input.tools);
    expect(result.extension).toBe(input.extension);
    expect(result.metadata).toEqual({ sessionId: 'sess_1' });
    expect(input.metadata.clientHeaders).toEqual({ session_id: 'sess_1' });
  });

  test('payload copy budget: provider request conversion borrows nested content and tools', () => {
    const typedContent = { type: 'input_text', text: 'hello' };
    const tool = { type: 'function', name: 'tool_a', parameters: { type: 'object' } };
    const metadata = { sessionId: 'sess_2' };
    const providerRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: [typedContent] }],
      tools: [tool],
      metadata,
      stream: true
    };

    const result = buildReplayInputFromProviderRequest(providerRequest, '/v1/responses');

    expect(result).not.toBe(providerRequest);
    expect(result.input[0].content[0]).toBe(typedContent);
    expect(result.tools).toBe(providerRequest.tools);
    expect(result.tools[0]).toBe(tool);
    expect(result.metadata).toBe(metadata);
  });
});
