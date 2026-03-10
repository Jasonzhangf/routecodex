#!/usr/bin/env node
/**
 * Regression: iFlow responses may encode tool calls as Qwen token markup in plain text.
 * Ensure compat (chat:iflow) harvests them into OpenAI `tool_calls`.
 */

import assert from 'node:assert/strict';
import { runRespInboundStage3CompatWithNative } from '../../dist/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

function applyResponseCompat(profile, payload, options = {}) {
  const adapterContext = options?.adapterContext && typeof options.adapterContext === 'object'
    ? options.adapterContext
    : {};
  return runRespInboundStage3CompatWithNative({
    payload,
    explicitProfile: profile,
    adapterContext
  });
}

async function main() {
  const cases = [
    {
      name: 'compact markers',
      content: [
        '继续\n\n',
        '<|tool_calls_section_begin|>\n',
        '<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {"cmd":"pwd","workdir":"/tmp"} <|tool_call_end|>\n',
        '<|tool_calls_section_end|>\n\n',
        'Find and fix a bug in ...\n'
      ].join(''),
      expectTool: 'exec_command'
    },
    {
      name: 'whitespace/newline markers + empty args',
      content: [
        'The push command is running. Let me wait for it to finish.  <|tool_calls_section_begin|> <|',
        '  tool_call_begin|> functions.write_stdin:69 <|tool_call_argument_begin|> {} <|tool_call_end|> <|',
        '  tool_calls_section_end|>\n'
      ].join('\n'),
      expectTool: 'write_stdin'
    },
    {
      name: 'invalid json (raw newline in string) + command alias',
      content: [
        'Ok.\n',
        '<|tool_calls_section_begin|>\n',
        '<|tool_call_begin|> functions.exec_command:45 <|tool_call_argument_begin|>\n',
        // NOTE: models sometimes emit raw newlines inside JSON string literals (invalid JSON).
        // The harvester should repair this and map `command` -> `cmd`.
        '{\"command\":\"head -70 /Users/fanzhang/Documents/github/itermRemote/scripts/test/\n',
        'render_multi_panel_overlay.py\"}\n',
        '<|tool_call_end|>\n',
        '<|tool_calls_section_end|>\n'
      ].join(''),
      expectTool: 'exec_command'
    },
    {
      name: 'iflow body wrapper unwraps to choices',
      wrapAsIflowBodyEnvelope: true,
      content: [
        '继续\n\n',
        '<|tool_calls_section_begin|>\n',
        '<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {"cmd":"pwd","workdir":"/tmp"} <|tool_call_end|>\n',
        '<|tool_calls_section_end|>\n\n'
      ].join(''),
      expectTool: 'exec_command'
    },
    {
      name: 'iflow body wrapper unwraps from body SSE text',
      wrapAsIflowBodyEnvelope: true,
      wrapBodyAsSseText: true,
      content: [
        '继续\n\n',
        '<|tool_calls_section_begin|>\n',
        '<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {"cmd":"pwd","workdir":"/tmp"} <|tool_call_end|>\n',
        '<|tool_calls_section_end|>\n\n'
      ].join(''),
      expectTool: 'exec_command'
    },
    {
      name: 'orphan function_calls tag cleaned (no tool calls)',
      content: [
        '• 有语法错误。让我修复脚本：\n',
        '  </function_calls>\n',
        '\n',
        '继续。\n'
      ].join(''),
      expectTool: null
    }
  ];

  for (const c of cases) {
    const inner = {
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'kimi-k2.5',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: c.content
          }
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    };

    const payload = c.wrapAsIflowBodyEnvelope
      ? (() => {
          const body = c.wrapBodyAsSseText
            ? [
                'data: {"ignored":true}',
                `data: ${JSON.stringify(inner)}`,
                'data: [DONE]',
                ''
              ].join('\n')
            : inner;
          return {
            status: 0,
            msg: 'ok',
            body,
            request_id: 'iflow_req_1'
          };
        })()
      : inner;

    const result = applyResponseCompat('chat:iflow', payload, { adapterContext: { providerProtocol: 'openai-chat' } });
    const out = result.payload;

    const msg = out?.choices?.[0]?.message;
    assert.ok(msg, `[${c.name}] missing choices[0].message`);
    if (c.expectTool) {
      assert.ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, `[${c.name}] tool_calls not harvested`);
      assert.equal(msg.tool_calls[0]?.function?.name, c.expectTool, `[${c.name}] unexpected tool name`);
      assert.equal(typeof msg.tool_calls[0]?.function?.arguments, 'string', `[${c.name}] arguments not string`);
      assert.equal(out.choices?.[0]?.finish_reason, 'tool_calls', `[${c.name}] finish_reason not tool_calls`);
    } else {
      assert.ok(!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0, `[${c.name}] expected no tool_calls`);
      assert.ok(typeof msg.content === 'string', `[${c.name}] expected string content`);
      assert.ok(!String(msg.content).includes('</function_calls>'), `[${c.name}] orphan tag not cleaned`);
    }

    if (c.name.includes('command alias')) {
      const args = JSON.parse(msg.tool_calls[0].function.arguments);
      assert.ok(typeof args.cmd === 'string' && args.cmd.includes('render_multi_panel_overlay.py'), `[${c.name}] cmd not repaired`);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[matrix:compat-iflow-qwen-tool-tokens] ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matrix:compat-iflow-qwen-tool-tokens] failed', err);
  process.exit(1);
});
