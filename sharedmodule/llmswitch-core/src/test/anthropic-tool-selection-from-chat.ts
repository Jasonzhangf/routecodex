/**
 * Anthropic 工具选择映射测试（Chat → Anthropic）
 *
 * 目标：
 *  - 构造一条仅包含 tool_calls 的标准 Chat 响应；
 *  - 通过 AnthropicOpenAIConversionCodec.convertResponse 编码为 Anthropic Message；
 *  - 断言：
 *      - content 中包含 type='tool_use' 的块；
 *      - stop_reason 为 'tool_use'（与 Responses 路径语义一致：表示“选择工具”而非普通结束）。
 *
 * 注意：
 *  - 这里不走 openai-openai 过滤器，只验证 Anthropic codec 对 Chat 形状的映射规则；
 *  - Chat 工具治理链在 Responses / v2 已经验证，通过此测试确保 Anthropic 映射保持同样语义。
 */

import { AnthropicOpenAIConversionCodec as Codec } from '../conversion/codecs/anthropic-openai-codec.js';

type AnyObj = Record<string, unknown>;

function buildToolSelectionChatResponse(): AnyObj {
  return {
    id: 'chatcmpl_test_tool_selection',
    object: 'chat.completion',
    model: 'chat-model-a',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_test_ls',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: JSON.stringify({
                  command: 'ls -la',
                  description: '列出当前目录的文件和文件夹'
                })
              }
            }
          ]
        }
      }
    ],
    usage: {}
  };
}

async function run() {
  const codec = new Codec({});
  await codec.initialize();

  const chatResp = buildToolSelectionChatResponse();
  const profile: any = { id: 'anthropic-standard', from: 'openai-chat', to: 'anthropic-messages' };
  const ctx: any = {
    endpoint: 'anthropic',
    entryEndpoint: '/v1/messages',
    stream: false,
    requestId: 'anth-tool-selection-from-chat'
  };

  const anthMsg = await codec.convertResponse(chatResp, profile, ctx);
  const content = Array.isArray((anthMsg as any)?.content) ? (anthMsg as any).content as AnyObj[] : [];
  const blockTypes = content.map(b => String((b as any).type || ''));
  const hasToolUse = blockTypes.includes('tool_use');
  const stopReason = (anthMsg as any)?.stop_reason ?? null;

  const summary = {
    model: (anthMsg as any)?.model,
    stop_reason: stopReason,
    blockTypes
  };

  // eslint-disable-next-line no-console
  console.log('[anthropic-tool-selection-from-chat] summary:', summary);

  if (!hasToolUse) {
    throw new Error('Anthropic mapping lost tool_use block for tool_calls Chat response');
  }
  if (stopReason !== 'tool_use') {
    throw new Error(`Anthropic stop_reason expected 'tool_use' for tool_calls, got: ${String(stopReason)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(err => {
    // eslint-disable-next-line no-console
    console.error('[anthropic-tool-selection-from-chat] FAILED:', err);
    process.exit(1);
  });
}
