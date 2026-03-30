#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../dist/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

function applyRequestCompat(profile, payload, options = {}) {
  const adapterContext = options?.adapterContext && typeof options.adapterContext === 'object'
    ? options.adapterContext
    : {};
  return runReqOutboundStage3CompatWithNative({
    payload,
    explicitProfile: profile,
    adapterContext
  });
}

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

function buildAdapterContext(overrides = {}) {
  return {
    requestId: 'req_deepseek_m3',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    routeId: 'default',
    compatibilityProfile: 'chat:deepseek-web',
    ...overrides
  };
}

function buildCapturedRequest({ required = true, tools } = {}) {
  const defaultTools = [
    {
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'string' }
          },
          required: ['cmd']
        }
      }
    }
  ];
  return {
    model: 'deepseek-chat',
    tools: Array.isArray(tools) ? tools : defaultTools,
    tool_choice: required ? 'required' : 'auto'
  };
}

function testRequestTransform() {
  const payload = {
    model: 'deepseek-chat-search',
    stream: true,
    messages: [
      { role: 'user', content: 'Search latest RouteCodex updates' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'Execute shell command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' }
            },
            required: ['cmd']
          }
        }
      }
    ],
    tool_choice: 'required'
  };

  const out = applyRequestCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      routeId: 'search/search-primary',
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      }
    })
  }).payload;

  assert.equal(typeof out.prompt, 'string', 'request compat should produce prompt');
  assert.ok(out.prompt.length > 0, 'prompt should not be empty');
  assert.equal(out.thinking_enabled, false, 'deepseek-chat-search should keep thinking disabled');
  assert.equal(out.search_enabled, true, 'search route should force search_enabled=true');
  assert.equal(out.stream, true, 'stream should be preserved');
  assert.equal(Array.isArray(out.ref_file_ids), true, 'ref_file_ids should be array');
  assert.equal(
    out.prompt.includes('Tool-call output contract (STRICT):'),
    true,
    'prompt should include strict tool-call output contract'
  );
  assert.equal(
    out.prompt.includes('tool_choice is required for this turn: return at least one tool call.'),
    true,
    'required tool_choice should be emphasized in prompt'
  );
  assert.equal(
    out.prompt.includes('Do NOT output pseudo tool results in text'),
    true,
    'prompt should forbid pseudo tool-result text blocks'
  );
}

function testRequestTransformAutoToolChoiceHint() {
  const payload = {
    model: 'deepseek-chat',
    stream: true,
    messages: [{ role: 'user', content: 'Check README quickly' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'Execute shell command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' }
            },
            required: ['cmd']
          }
        }
      }
    ],
    tool_choice: 'auto'
  };

  const out = applyRequestCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      }
    })
  }).payload;

  assert.equal(
    out.prompt.includes('If no tool is needed, plain text is allowed.'),
    true,
    'auto tool_choice should retain plain-text allowance'
  );
}

function testNativeToolCalls() {
  const payload = {
    id: 'chatcmpl_native',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_native_1',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}'
              }
            }
          ]
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: true })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, 'native tool call should be kept');
  assert.equal(out.choices?.[0]?.finish_reason, 'tool_calls', 'finish_reason should be tool_calls');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'native_tool_calls');
}

function testTextFallbackToolCalls() {
  const payload = {
    id: 'chatcmpl_fallback',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '{"tool_calls":[{"name":"exec_command","input":{"cmd":"git status"}}]}'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: true })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, 'text fallback should extract tool call');
  assert.equal(msg.tool_calls[0]?.function?.name, 'exec_command');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
  assert.equal(out.metadata?.deepseek?.toolCallSource, 'fallback');
}

function testTextFallbackToolCallsWithTailSentinel() {
  const payload = {
    id: 'chatcmpl_fallback_tail_sentinel',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '{"tool_calls":[{"name":"exec_command","input":{"cmd":"git status"}}]}<| User |>'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: true })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, 'tail sentinel should not block tool_call harvest');
  assert.equal(msg.tool_calls[0]?.function?.name, 'exec_command');
  assert.equal(out.choices?.[0]?.finish_reason, 'tool_calls');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
  assert.equal(out.metadata?.deepseek?.toolCallSource, 'fallback');
}

function testQuotedToolCallsAreHarvested() {
  const payload = {
    id: 'chatcmpl_quoted_tool_calls',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '原文是：<quote>{"tool_calls":[{"name":"exec_command","input":{"cmd":"git status"}}]}</quote>'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: false,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(
    Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1,
    'quoted tool_calls text should be harvested into executable tool call'
  );
  assert.equal(msg.tool_calls[0]?.function?.name, 'exec_command');
  const args = JSON.parse(msg.tool_calls[0]?.function?.arguments || '{}');
  assert.equal(args.cmd, 'git status');
  assert.equal(out.choices?.[0]?.finish_reason, 'tool_calls');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
}

function testFallbackRepairsEvenWhenRequestedToolsDiffer() {
  const payload = {
    id: 'chatcmpl_fallback_disallowed_tool',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '{"tool_calls":[{"name":"exec_command","input":{"cmd":"git status"}}]}'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: false,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({
        required: false,
        tools: [
          {
            type: 'function',
            function: {
              name: 'apply_patch',
              description: 'Apply unified patch',
              parameters: {
                type: 'object',
                properties: {
                  patch: { type: 'string' }
                },
                required: ['patch']
              }
            }
          }
        ]
      })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, 'fallback should prioritize salvage over dropping');
  assert.equal(msg.tool_calls[0]?.function?.name, 'exec_command');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
}

function testFallbackStillRepairsWhenRequestToolsEmpty() {
  const payload = {
    id: 'chatcmpl_fallback_no_tools_requested',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '{"tool_calls":[{"name":"exec_command","input":{"cmd":"git status"}}]}'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: false,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false, tools: [] })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, 'explicit empty request tools should not block salvage');
  assert.equal(msg.tool_calls[0]?.function?.name, 'exec_command');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
}

function testCommandBlockWithoutToolShapeStaysText() {
  const payload = {
    id: 'chatcmpl_command_fallback',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            '由于系统安全策略阻止了批量命令执行，我将分步操作：',
            '',
            '```bash',
            'pnpm config set electron_mirror https://npmmirror.com/mirrors/electron/',
            '```'
          ].join('\n')
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.equal(Array.isArray(msg?.tool_calls), false, 'plain bash block must not be guessed as tool call');
  assert.equal(out.choices?.[0]?.finish_reason, 'stop');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'no_tool_calls');
  const expected = 'pnpm config set electron_mirror https://npmmirror.com/mirrors/electron/';
  assert.equal(
    typeof msg?.content,
    'string',
    'assistant text should remain readable'
  );
  assert.equal(msg.content.includes(expected), true, 'assistant text should preserve original command content');
}

function testStrictRequiredFailure() {
  const payload = {
    id: 'chatcmpl_no_tool',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'I cannot call tools right now.'
        }
      }
    ]
  };

  assert.throws(
    () =>
      applyResponseCompat('chat:deepseek-web', payload, {
        adapterContext: buildAdapterContext({
          deepseek: {
            strictToolRequired: true,
            textToolFallback: false
          },
          capturedChatRequest: buildCapturedRequest({ required: true })
        })
      }),
    (error) => {
      assert.match(String(error?.message || ''), /tool_choice=required/i);
      return true;
    },
    'strict required mode should throw when no valid tool call exists'
  );
}

function testXmlToolCallBlocksAreHarvested() {
  const payload = {
    id: 'chatcmpl_xml_tool_call_blocks',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            '我来深入审查这些 AI 生成相关的核心文件。',
            '<tool_call>',
            '{"name":"exec_command","input":{"cmd":"cat apps/novelmobile/src/server/backend/routes/ai-generate.ts","workdir":"/Users/fanzhang/Documents/github/novelmobile"}}',
            '</tool_call>',
            '<tool_call>',
            '{"name":"exec_command","input":{"cmd":"cat apps/novelmobile/src/server/backend/routes/story-context.ts","workdir":"/Users/fanzhang/Documents/github/novelmobile"}}',
            '</tool_call>',
            '<tool_call>',
            '{"name":"exec_command","input":{"cmd":"cat apps/novelmobile/src/web/src/components/wizard/CardWizard.tsx","workdir":"/Users/fanzhang/Documents/github/novelmobile"}}',
            '</tool_call>'
          ].join('\n')
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: false,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls), 'xml <tool_call> blocks should be harvested');
  assert.equal(msg.tool_calls.length, 3, 'all xml tool_call blocks should be preserved');
  for (const toolCall of msg.tool_calls) {
    assert.equal(toolCall?.function?.name, 'exec_command');
    const args = JSON.parse(toolCall?.function?.arguments || '{}');
    assert.equal(typeof args?.cmd, 'string');
    assert.equal(typeof args?.workdir, 'string');
  }
  assert.equal(out.choices?.[0]?.finish_reason, 'tool_calls');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
}

function testFunctionResultsMarkupHarvest() {
  const payload = {
    id: 'chatcmpl_function_results',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            '我注意到 Electron 安装有问题。让我先解决这个基础问题：',
            '',
            '<function_results>',
            '{',
            '  "exec_command": {',
            '    "stdout": "",',
            '    "stderr": "",',
            '    "exit_code": 0',
            '  }',
            '}',
            '</function_results>'
          ].join('\n')
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  const content = out.choices?.[0]?.message?.content;
  assert.equal(typeof content, 'string', 'message content should remain string');
  assert.equal(content.includes('<function_results>'), false, 'function_results open tag should be harvested');
  assert.equal(content.includes('</function_results>'), false, 'function_results close tag should be harvested');
  assert.equal(content.includes('```json'), true, 'harvested block should become json fenced block');
  assert.equal(content.includes('"exec_command"'), true, 'harvested block should retain function result payload');
  assert.equal(out.metadata?.deepseek?.functionResultsTextHarvested, true, 'compat metadata should audit harvested function_results');
}

function testCommentaryTagStrippedFromAssistantText() {
  const payload = {
    id: 'chatcmpl_commentary_tag',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            "Looking at `chat_process.rs` which currently has only 33.63% coverage (669 missed lines), I'll first understand its structure to plan targeted test additions.",
            '',
            '<commentary>开始分析 `chat_process.rs` 的代码结构，查找主要函数入口，为针对性补充测试做准备。</commentary>'
          ].join('\n')
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: false,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  const content = out.choices?.[0]?.message?.content;
  assert.equal(typeof content, 'string', 'message content should remain string');
  assert.equal(content.includes('<commentary>'), false, 'commentary open tag should be stripped');
  assert.equal(content.includes('</commentary>'), false, 'commentary close tag should be stripped');
  assert.equal(
    content.includes("Looking at `chat_process.rs`"),
    true,
    'primary assistant text should be preserved'
  );
}

function testBusinessEnvelopeUnwrap() {
  const payload = {
    code: 0,
    msg: '',
    data: {
      id: 'chatcmpl_wrapped',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"tool_calls":[{"name":"exec_command","input":{"cmd":"pwd"}}]}'
          }
        }
      ]
    }
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: true })
    })
  }).payload;

  const msg = out.choices?.[0]?.message;
  assert.ok(Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, 'wrapped response should be unwrapped and tool call harvested');
  assert.equal(msg.tool_calls[0]?.function?.name, 'exec_command');
  assert.equal(out.metadata?.deepseek?.toolCallState, 'text_tool_calls');
}

function testBusinessEnvelopeReadableError() {
  const payload = {
    code: 0,
    msg: '',
    data: {
      biz_code: 3,
      biz_msg: 'message count exceeded',
      biz_data: null
    },
    request_id: 'req_deepseek_biz_error'
  };

  assert.throws(
    () =>
      applyResponseCompat('chat:deepseek-web', payload, {
        adapterContext: buildAdapterContext({
          deepseek: {
            strictToolRequired: true,
            textToolFallback: true
          }
        })
      }),
    (error) => {
      assert.match(String(error?.message || ''), /upstream business error/i);
      assert.match(String(error?.message || ''), /message count exceeded/i);
      return true;
    },
    'deepseek business envelope should become readable upstream error'
  );
}

function testUsageBackfillFromEstimate() {
  const payload = {
    id: 'chatcmpl_usage_backfill',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'hello from deepseek usage estimation'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      estimatedInputTokens: 42,
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  assert.equal(out.usage?.prompt_tokens, 42, 'prompt tokens should use estimatedInputTokens');
  assert.equal(typeof out.usage?.completion_tokens, 'number', 'completion tokens should be estimated');
  assert.equal(out.usage?.completion_tokens > 0, true, 'completion estimate should be positive');
  assert.equal(
    out.usage?.total_tokens,
    out.usage?.prompt_tokens + out.usage?.completion_tokens,
    'total tokens should be prompt + completion'
  );
  assert.equal(out.usage?.input_tokens, out.usage?.prompt_tokens, 'input_tokens mirror prompt_tokens');
  assert.equal(out.usage?.output_tokens, out.usage?.completion_tokens, 'output_tokens mirror completion_tokens');
}

function testUsageKeepsUpstreamWhenPresent() {
  const payload = {
    id: 'chatcmpl_usage_upstream',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17
    },
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
  };

  const out = applyResponseCompat('chat:deepseek-web', payload, {
    adapterContext: buildAdapterContext({
      estimatedInputTokens: 999,
      deepseek: {
        strictToolRequired: true,
        textToolFallback: true
      },
      capturedChatRequest: buildCapturedRequest({ required: false })
    })
  }).payload;

  assert.equal(out.usage?.prompt_tokens, 10, 'upstream prompt tokens should be preserved');
  assert.equal(out.usage?.completion_tokens, 7, 'upstream completion tokens should be preserved');
  assert.equal(out.usage?.total_tokens, 17, 'upstream total tokens should be preserved');
}

function testControlProviderUnaffected() {
  const payload = {
    id: 'chatcmpl_control',
    object: 'chat.completion',
    created: 1,
    model: 'kimi-k2.5',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'plain response'
        }
      }
    ]
  };

  const out = applyResponseCompat('chat:iflow', payload, {
    adapterContext: {
      requestId: 'req_control',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      compatibilityProfile: 'chat:iflow'
    }
  }).payload;

  assert.equal(out.choices?.[0]?.message?.content, 'plain response', 'control provider should keep payload');
}

function main() {
  testRequestTransform();
  testRequestTransformAutoToolChoiceHint();
  testNativeToolCalls();
  testTextFallbackToolCalls();
  testTextFallbackToolCallsWithTailSentinel();
  testQuotedToolCallsAreHarvested();
  testFallbackRepairsEvenWhenRequestedToolsDiffer();
  testFallbackStillRepairsWhenRequestToolsEmpty();
  testCommandBlockWithoutToolShapeStaysText();
  testStrictRequiredFailure();
  testXmlToolCallBlocksAreHarvested();
  testFunctionResultsMarkupHarvest();
  testCommentaryTagStrippedFromAssistantText();
  testBusinessEnvelopeUnwrap();
  testBusinessEnvelopeReadableError();
  testUsageBackfillFromEstimate();
  testUsageKeepsUpstreamWhenPresent();
  testControlProviderUnaffected();
  console.log('[matrix:deepseek-web-compat-tool-calling] ok');
}

main();
