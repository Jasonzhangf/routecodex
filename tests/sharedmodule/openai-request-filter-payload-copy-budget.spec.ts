import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { runOpenAIRequestCodecDirectNative } from './helpers/openai-codec-direct-native.js';

describe('OpenAI request filter payload copy budget', () => {
  it('uses one owned Rust filter path without an internal JSON round-trip', () => {
    const filterSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_chat_request_filters.rs'
      ),
      'utf8'
    );
    const codecSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/openai_openai_codec.rs'
      ),
      'utf8'
    );
    const requestCodec = codecSource.match(
      /pub fn run_openai_openai_request_codec_json[\s\S]*?\n}\n\n#\[napi\(js_name = "runOpenaiOpenaiResponseCodecJson"\)\]/
    )?.[0] ?? '';

    expect(filterSource).toContain('prune_chat_request_payload_owned');
    expect(filterSource).not.toMatch(/fn prune_chat_request_payload_impl\(payload: &Value/);
    expect(requestCodec).toContain('prune_chat_request_payload_owned(payload');
    expect(requestCodec).not.toContain('prune_chat_request_payload_json(');
    expect(requestCodec).not.toContain('serde_json::json!({');
  });

  it('preserves exact established provider-wire filtering semantics', () => {
    const output = runOpenAIRequestCodecDirectNative(
      {
        model: 'gpt-test',
        __rcc_hidden: true,
        metadata: { internal: true },
        originalStream: true,
        _originalStreamOptions: { include_usage: true },
        stream: false,
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_wire',
              call_id: 'call_internal',
              tool_call_id: 'call_legacy',
              type: 'function',
              function: {
                name: 'large_tool',
                arguments: { value: 'x'.repeat(1024) }
              }
            }]
          },
          {
            role: 'tool',
            call_id: 'call_wire',
            id: 'legacy_result_id',
            content: 'result'
          }
        ],
        extension: {
          nested: ['kept', { exactly: true }]
        }
      },
      { preserveStreamField: false }
    );

    expect(output).not.toHaveProperty('__rcc_hidden');
    expect(output).not.toHaveProperty('metadata');
    expect(output).not.toHaveProperty('originalStream');
    expect(output).not.toHaveProperty('_originalStreamOptions');
    expect(output).not.toHaveProperty('stream');
    expect(output.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_wire',
          type: 'function',
          function: {
            name: 'large_tool',
            arguments: '{"value":"' + 'x'.repeat(1024) + '"}'
          }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_wire',
        content: 'result'
      }
    ]);
    expect(output.extension).toEqual({
      nested: ['kept', { exactly: true }]
    });
  });
});
