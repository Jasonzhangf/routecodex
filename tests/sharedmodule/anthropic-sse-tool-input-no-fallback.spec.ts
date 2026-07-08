import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;
const buildAnthropicSseEventSequenceJson = nativeBinding.buildAnthropicSseEventSequenceJson as (inputJson: string) => unknown;

type AnthropicMessageResponse = Record<string, unknown> & {
  content?: unknown[];
};

describe('anthropic SSE tool input no-fallback boundary', () => {
  it('returns the Rust fail-fast error for missing tool input instead of synthesizing a fallback value', async () => {
    const response: AnthropicMessageResponse = {
      id: 'msg_anthropic_tool_input_no_fallback',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'exec_command'
        }
      ],
      stop_reason: 'tool_use'
    };

    const raw = buildAnthropicSseEventSequenceJson(JSON.stringify({
      response,
      request_id: 'req_anthropic_tool_input_no_fallback'
    }));

    const nativeError = raw as { message?: unknown; code?: unknown };
    expect(String(nativeError.message)).toContain('Invalid Anthropic tool_use block: missing input');
    expect(nativeError.code).toBe('GenericFailure');
    expect(String(nativeError.message)).not.toContain('partial_json');
    expect(String(nativeError.message)).not.toContain('null');
  });
});
