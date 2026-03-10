/**
 * Anthropic 输出侧闭环测试（非流）：
 *   ChatResponse(JSON) → AnthropicMessage(JSON) → ChatRequest(JSON)
 *
 * 目标：
 *  - 验证 anthropic-openai-codec 的 buildAnthropicFromOpenAIChat / buildOpenAIChatFromAnthropic 组合
 *    在常见文本 / 工具调用场景下保持语义等价；
 *  - 为后续 SSE 闭环提供基准视图。
 */

import fs from 'fs';
import path from 'path';
import { AnthropicOpenAIConversionCodec as Codec } from '../conversion/codecs/anthropic-openai-codec.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function makeTextOnlyChatResponse(): AnyObj {
  return {
    id: 'chatcmpl_test_text',
    object: 'chat.completion',
    model: 'gpt-5.1',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'Hello from Chat model.'
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };
}

function makeToolCallChatResponse(): AnyObj {
  return {
    id: 'chatcmpl_test_tool',
    object: 'chat.completion',
    model: 'gpt-5.1',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_test_1',
              type: 'function',
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: 'test keyword', limit: 3 })
              }
            }
          ]
        }
      }
    ],
    usage: { prompt_tokens: 20, completion_tokens: 3 }
  };
}

function collectChatResponseView(chat: AnyObj) {
  const choices = Array.isArray((chat as any).choices) ? ((chat as any).choices as AnyObj[]) : [];
  const primary = choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
  const msg = asObj((primary as any).message);
  const model = String((chat as any).model || '');
  const role = String((msg as any).role || '');
  const content = (msg as any).content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : ''))
      .filter(Boolean)
      .join('');
  }
  const toolCalls: Array<{ name: string; argsSample: string }> = [];
  const calls = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as AnyObj[]) : [];
  for (const tc of calls) {
    const fn = (tc as any).function || {};
    const name = typeof fn.name === 'string' ? fn.name : '';
    const rawArgs = (fn as any).arguments;
    const argsSample =
      typeof rawArgs === 'string'
        ? rawArgs.slice(0, 80)
        : (() => {
            try {
              return JSON.stringify(rawArgs ?? {}).slice(0, 80);
            } catch {
              return '';
            }
          })();
    toolCalls.push({ name, argsSample });
  }
  return { model, role, text, toolCalls };
}

function collectChatRequestView(chatReq: AnyObj) {
  const model = String((chatReq as any).model || '');
  const messages = Array.isArray((chatReq as any).messages) ? ((chatReq as any).messages as AnyObj[]) : [];
  const toolCalls: Array<{ name: string; argsSample: string }> = [];
  let assistantText = '';
  const collectText = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(collectText).join('');
    if (typeof val === 'object') {
      if (typeof (val as any).text === 'string') return String((val as any).text);
      if (Array.isArray((val as any).content)) return collectText((val as any).content);
    }
    return '';
  };
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as any).role || '');
    if (!assistantText && role === 'assistant') {
      assistantText = collectText((m as any).content).trim();
    }
    const calls = Array.isArray((m as any).tool_calls) ? ((m as any).tool_calls as AnyObj[]) : [];
    for (const tc of calls) {
      const fn = (tc as any).function || {};
      const name = typeof fn.name === 'string' ? fn.name : '';
      const rawArgs = (fn as any).arguments;
      const argsSample =
        typeof rawArgs === 'string'
          ? rawArgs.slice(0, 80)
          : (() => {
              try {
                return JSON.stringify(rawArgs ?? {}).slice(0, 80);
              } catch {
                return '';
              }
            })();
      toolCalls.push({ name, argsSample });
    }
  }
  return { model, assistantText, toolCalls };
}

function writeSnapshot(label: string, payload: AnyObj) {
  try {
    const baseDir = process.env.LLMSWITCH_ANTH_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_ANTH_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'anthropic-bridge');
    fs.mkdirSync(baseDir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-anth-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf8');
  } catch {
    // ignore snapshot errors in tests
  }
}

async function runAnthropicBridgeClosedLoop() {
  const codec = new Codec({});
  await codec.initialize();

  const cases: Array<{ label: string; chat: AnyObj }> = [
    { label: 'builtin:anth-text-only', chat: makeTextOnlyChatResponse() },
    { label: 'builtin:anth-tool-call', chat: makeToolCallChatResponse() }
  ];

  for (const { label, chat } of cases) {
    console.log(`\n=== Anthropic Closed Loop Case: ${label} ===`);
    const viewBefore = collectChatResponseView(chat);

    // ChatResponse → AnthropicMessage（convertResponse，关闭 SSE 分支）
    const profile: any = { id: 'anthropic-standard', from: 'openai-chat', to: 'anthropic-messages' };
    const ctxResp: any = { endpoint: 'anthropic', entryEndpoint: '/v1/chat/completions', stream: false, requestId: label };
    const anthropicMsg = (await codec.convertResponse(chat, profile, ctxResp)) as AnyObj;

    // AnthropicMessage → AnthropicRequest-like（messages[]），再通过 convertRequest → ChatRequest
    const anthReqLike: AnyObj = {
      model: anthropicMsg.model,
      messages: [
        {
          role: anthropicMsg.role,
          content: anthropicMsg.content
        }
      ]
    };
    const ctxReq: any = { endpoint: 'anthropic', entryEndpoint: '/v1/messages', stream: false, requestId: `${label}_back` };
    const chatReq = asObj(await codec.convertRequest(anthReqLike, profile, ctxReq));
    const viewAfter = collectChatRequestView(chatReq);

    writeSnapshot(label, { chatBefore: chat, anthropicMsg, chatReq, viewBefore, viewAfter });

    console.log('ChatResponse view:', viewBefore);
    console.log('ChatRequest view after closed loop:', viewAfter);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicBridgeClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic closed loop test failed:', err);
    process.exit(1);
  });
}

