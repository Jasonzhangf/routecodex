/**
 * Chat → Responses SSE → Responses JSON → Chat 闭环测试
 *
 * 目的：
 *  - 验证基于 Chat JSON 的 Responses SSE 事件序列在聚合回 JSON 后，
 *    再通过 buildChatResponseFromResponses 还原为 ChatResponse 时，
 *    模型 / finish_reason / 文本 / 工具调用 是否保持一致。
 *
 * 使用方式（在 sharedmodule/llmswitch-core 下）：
 *  - npm run build
 *  - LLMSWITCH_RESPONSES_CHAT_FIXTURES=<逗号分隔样本路径> node dist/test/responses-sse-closed-loop.js
 */

import fs from 'fs';
import path from 'path';
import { createResponsesSSEStreamFromChatJson } from '../conversion/streaming/json-to-responses-sse.js';
import { buildChatResponseFromResponses } from '../conversion/responses/responses-openai-bridge.js';
import { AnyObj, asObj, collectSimpleChatView, diffSimpleView, extractChatFromSample } from './responses-bridge-closed-loop.js';

interface SseEvent {
  event: string;
  data: AnyObj;
}

async function readSSEFromStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c: any) => {
      if (c == null) return;
      if (Buffer.isBuffer(c)) chunks.push(c);
      else chunks.push(Buffer.from(String(c)));
    });
    stream.on('end', () => resolve());
    stream.on('error', err => reject(err));
  });
  return Buffer.concat(chunks).toString('utf-8');
}

function parseSSE(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const lines = text.split('\n');
  let curEvent: string | null = null;
  let curData: string[] = [];

  const flush = () => {
    if (!curEvent || curData.length === 0) {
      curEvent = null;
      curData = [];
      return;
    }
    const raw = curData.join('\n');
    try {
      const parsed = JSON.parse(raw) as AnyObj;
      events.push({ event: curEvent, data: parsed });
    } catch {
      // ignore parse error
    }
    curEvent = null;
    curData = [];
  };

  for (const line of lines) {
    if (!line.trim().length) {
      flush();
      continue;
    }
    if (line.startsWith(':')) {
      // heartbeat 注释，忽略
      continue;
    }
    if (line.startsWith('event:')) {
      flush();
      curEvent = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length).trim();
      curData.push(payload);
      continue;
    }
  }
  flush();
  return events;
}

function aggregateResponsesFromEvents(events: SseEvent[], fallbackModel: string): AnyObj {
  const state: {
    id?: string;
    model?: string;
    created_at?: number;
    status?: string;
    usage?: AnyObj;
    outputTextParts: string[];
    toolByItemId: Map<string, { id?: string; name: string; args: string }>;
  } = {
    outputTextParts: [],
    toolByItemId: new Map()
  };

  for (const ev of events) {
    const d = ev.data || {};
    if (ev.event === 'response.created' || ev.event === 'response.in_progress' || ev.event === 'response.completed') {
      const resp = asObj(d.response);
      if (resp.id && typeof resp.id === 'string') state.id = String(resp.id);
      if (resp.model && typeof resp.model === 'string') state.model = String(resp.model);
      if (typeof resp.created_at === 'number') state.created_at = resp.created_at;
      if (resp.status && typeof resp.status === 'string') state.status = String(resp.status);
      if (resp.usage && typeof resp.usage === 'object') state.usage = resp.usage as AnyObj;
    }

    if (ev.event === 'response.output_text.delta') {
      const delta = typeof (d as any).delta === 'string' ? String((d as any).delta) : '';
      if (delta) state.outputTextParts.push(delta);
      continue;
    }

    if (ev.event === 'response.output_item.added') {
      const item = asObj((d as any).item);
      const t = String(item.type || '').toLowerCase();
      if (t === 'function_call') {
        const rawName = (item as any).name;
        const name = typeof rawName === 'string' && rawName.trim().length ? rawName : 'tool';
        const id = typeof item.id === 'string' ? item.id : undefined;
        state.toolByItemId.set(String(item.id ?? ''), { id, name, args: '' });
      }
      continue;
    }

    if (ev.event === 'response.function_call_arguments.done') {
      const itemId = String((d as any).item_id ?? '');
      if (!itemId) continue;
      const entry = state.toolByItemId.get(itemId);
      if (!entry) {
        state.toolByItemId.set(itemId, {
          id: undefined,
          name: 'tool',
          args: String((d as any).arguments ?? '')
        });
        continue;
      }
      entry.args = String((d as any).arguments ?? '');
      state.toolByItemId.set(itemId, entry);
      continue;
    }
  }

  const output_text = state.outputTextParts.join('');
  const toolCalls: AnyObj[] = [];
  for (const [itemId, tc] of state.toolByItemId.entries()) {
    toolCalls.push({
      id: tc.id ?? itemId,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.args
      }
    });
  }

  const required_action = toolCalls.length
    ? {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: toolCalls
        }
      }
    : undefined;

  const model = state.model || fallbackModel || 'unknown';
  const id = state.id || `resp_${Date.now()}`;
  const created_at = state.created_at ?? Math.floor(Date.now() / 1000);
  const status = state.status || (toolCalls.length ? 'in_progress' : 'completed');

  const out: AnyObj = {
    id,
    object: 'response',
    created_at,
    model,
    status,
    output_text
  };
  if (state.usage) out.usage = state.usage;
  if (required_action) out.required_action = required_action;
  return out;
}

function loadChatFixturesFromEnv(): Array<{ label: string; chat: AnyObj }> {
  const out: Array<{ label: string; chat: AnyObj }> = [];
  const raw = process.env.LLMSWITCH_RESPONSES_CHAT_FIXTURES;
  if (!raw) return out;
  const paths = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of paths) {
    try {
      const txt = fs.readFileSync(p, 'utf-8');
      const loaded = JSON.parse(txt) as unknown as AnyObj;
      if (loaded && typeof loaded === 'object') {
        out.push({ label: `fixture:${p}`, chat: extractChatFromSample(asObj(loaded)) });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[responses-sse-closed-loop] 加载外部样本失败', p, (e as any)?.message || String(e));
    }
  }
  return out;
}

function writeSnapshot(label: string, payload: {
  chatBefore: AnyObj;
  sseRaw: string;
  responsesFromSse: AnyObj;
  chatAfter: AnyObj;
  viewBefore: ReturnType<typeof collectSimpleChatView>;
  viewAfter: ReturnType<typeof collectSimpleChatView>;
}): void {
  try {
    const baseDir = process.env.LLMSWITCH_RESPONSES_SSE_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_RESPONSES_SSE_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'responses-sse-bridge');
    fs.mkdirSync(baseDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-sse-${safeLabel}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf-8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[responses-sse-closed-loop] 写入快照失败', (e as any)?.message || String(e));
  }
}

async function runSseClosedLoopTests(): Promise<void> {
  const cases: Array<{ label: string; chat: AnyObj }> = [];

  cases.push(...loadChatFixturesFromEnv());

  if (cases.length === 0) {
    console.log('No SSE fixtures provided via LLMSWITCH_RESPONSES_CHAT_FIXTURES, nothing to run.');
    return;
  }

  for (const { label, chat } of cases) {
    console.log(`\n=== SSE Case: ${label} ===`);
    const viewBefore = collectSimpleChatView(chat);
    const model = String((chat as any).model || 'unknown');

    const stream = createResponsesSSEStreamFromChatJson(chat, { requestId: `sse_${label}` });
    const sseRaw = await readSSEFromStream(stream);
    const events = parseSSE(sseRaw);
    const respFromSse = aggregateResponsesFromEvents(events, model);
    const chatAfter = buildChatResponseFromResponses(respFromSse) as AnyObj;
    const viewAfter = collectSimpleChatView(chatAfter);

    writeSnapshot(label, {
      chatBefore: chat,
      sseRaw,
      responsesFromSse: respFromSse,
      chatAfter,
      viewBefore,
      viewAfter
    });

    diffSimpleView(label, viewBefore, viewAfter);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSseClosedLoopTests().catch(err => {
    console.error('SSE closed loop test failed:', err);
    process.exit(1);
  });
}

