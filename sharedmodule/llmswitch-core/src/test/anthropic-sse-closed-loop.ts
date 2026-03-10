/**
 * Anthropic SSE 输出闭环测试：
 *   ChatResponse(JSON) → Anthropic SSE（createAnthropicSSEStreamFromChatJson）
 *                    → 聚合回 AnthropicMessage(JSON) → ChatRequest(JSON)
 *
 * 目标：
 *  - 验证 json-to-anthropic-sse.ts 生成的事件序列可以被还原成语义等价的 Anthropic 消息；
 *  - 再通过 anthropic-openai-codec 的 request 方向还原 Chat 视图，用于和非流式输出闭环对齐。
 */

import fs from 'fs';
import path from 'path';
import { AnthropicOpenAIConversionCodec as Codec } from '../conversion/codecs/anthropic-openai-codec.js';
import { createAnthropicSSEStreamFromChatJson } from '../conversion/streaming/json-to-anthropic-sse.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function makeTextOnlyChatResponse(): AnyObj {
  return {
    id: 'chatcmpl_sse_text',
    object: 'chat.completion',
    model: 'gpt-5.1',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'Hello from SSE Chat model.'
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };
}

function makeToolCallChatResponse(): AnyObj {
  return {
    id: 'chatcmpl_sse_tool',
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
              id: 'call_sse_1',
              type: 'function',
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: 'sse test', limit: 2 })
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
    const baseDir = process.env.LLMSWITCH_ANTH_SSE_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_ANTH_SSE_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'anthropic-sse-bridge');
    fs.mkdirSync(baseDir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-anth-sse-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf8');
  } catch {
    // ignore snapshot errors in tests
  }
}

async function aggregateAnthropicSSEToMessage(readable: NodeJS.ReadableStream): Promise<AnyObj> {
  return new Promise((resolve) => {
    let currentRole = 'assistant';
    let model = 'unknown';
    let textBuf = '';
    const toolBlocks: AnyObj[] = [];
    const pendingInput: Record<string, string> = {};

    let currentEvent: string | null = null;
    let currentIndex = 0;

    const onLine = (line: string) => {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice('event: '.length).trim();
        return;
      }
      if (line.startsWith('data: ')) {
        const raw = line.slice('data: '.length);
        let data: AnyObj = {};
        try {
          data = JSON.parse(raw) as AnyObj;
        } catch {
          // ignore parse errors
        }
        const evt = String((data as any).type || currentEvent || '').toLowerCase();
        if (evt === 'message_start') {
          const msg = asObj((data as any).message);
          if (typeof msg.role === 'string') currentRole = msg.role;
          if (typeof msg.model === 'string') model = msg.model;
        } else if (evt === 'content_block_start') {
          currentIndex = Number((data as any).index ?? 0);
          const cb = asObj((data as any).content_block);
          const t = String(cb.type || '').toLowerCase();
          if (t === 'tool_use') {
            const id = String(cb.id || `tool_${currentIndex}`);
            pendingInput[id] = '';
            toolBlocks.push({ type: 'tool_use', id, name: cb.name, input: {} });
          }
        } else if (evt === 'content_block_delta') {
          currentIndex = Number((data as any).index ?? currentIndex);
          const delta = asObj((data as any).delta);
          const t = String(delta.type || '').toLowerCase();
          if (t === 'text_delta' && typeof delta.text === 'string') {
            textBuf += delta.text;
          } else if (t === 'input_json_delta' && typeof delta.partial_json === 'string') {
            // 归集到最近的 tool_use 上
            const keys = Object.keys(pendingInput);
            if (keys.length) {
              const lastId = keys[keys.length - 1];
              pendingInput[lastId] += delta.partial_json;
            }
          }
        } else if (evt === 'content_block_stop') {
          // 完成一个 tool_use 的 input 聚合
          for (const tb of toolBlocks) {
            const id = String((tb as any).id || '');
            const buf = pendingInput[id];
            if (buf && buf.trim().length) {
              try {
                (tb as any).input = JSON.parse(buf);
              } catch {
                (tb as any).input = { _raw: buf };
              }
            }
          }
        }
      }
    };

    let buffer = '';
    readable.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        onLine(line);
      }
    });
    readable.on('end', () => {
      const content: AnyObj[] = [];
      if (textBuf.trim().length) {
        content.push({ type: 'text', text: textBuf.trim() });
      }
      for (const tb of toolBlocks) content.push(tb);
      resolve({ type: 'message', role: currentRole, model, content });
    });
  });
}

async function runAnthropicSseClosedLoop() {
  const codec = new Codec({});
  await codec.initialize();

  const cases: Array<{ label: string; chat: AnyObj }> = [
    { label: 'builtin:anth-sse-text-only', chat: makeTextOnlyChatResponse() },
    { label: 'builtin:anth-sse-tool-call', chat: makeToolCallChatResponse() }
  ];

  for (const { label, chat } of cases) {
    console.log(`\n=== Anthropic SSE Closed Loop Case: ${label} ===`);
    const viewBefore = collectChatResponseView(chat);

    const readable = createAnthropicSSEStreamFromChatJson(chat, { requestId: label });
    const anthMsg = await aggregateAnthropicSSEToMessage(readable);

    const anthReqLike: AnyObj = {
      model: anthMsg.model,
      messages: [
        {
          role: anthMsg.role,
          content: anthMsg.content
        }
      ]
    };
    const profile: any = { id: 'anthropic-standard', from: 'anthropic-messages', to: 'openai-chat' };
    const ctxReq: any = { endpoint: 'anthropic', entryEndpoint: '/v1/messages', stream: false, requestId: `${label}_back` };
    const chatReq = asObj(await codec.convertRequest(anthReqLike, profile, ctxReq));
    const viewAfter = collectChatRequestView(chatReq);

    writeSnapshot(label, { chatBefore: chat, anthropicMessage: anthMsg, chatReq, viewBefore, viewAfter });

    console.log('ChatResponse view:', viewBefore);
    console.log('ChatRequest view after SSE closed loop:', viewAfter);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicSseClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic SSE closed loop test failed:', err);
    process.exit(1);
  });
}

