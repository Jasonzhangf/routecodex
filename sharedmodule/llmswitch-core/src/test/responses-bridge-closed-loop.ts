/**
 * Chat → Responses 编解码单向验证（非流）
 *
 * 当前阶段只验证：
 *  1. buildResponsesPayloadFromChat(chat) 生成的 Responses JSON 形状/字段是否合理
 *  2. 文本与工具调用在 Chat→Responses 映射过程中是否被保住（通过简化视图对比）
 *
 * 注意：真正的 “ChatResponse ↔ ResponsesResponse 闭环” 会在后续增加专门的
 * decodeChatResponseFromResponses 之后再实现，这里暂不做 Responses→Chat 的逆向解码，
 * 以避免误用 request 解码器导致的干扰。
 *
 * 运行方式（在 sharedmodule/llmswitch-core 下）：
 *  - npm run build
 *  - node dist/test/responses-bridge-closed-loop.js
 */

import { buildResponsesPayloadFromChat, buildChatResponseFromResponses } from '../conversion/responses/responses-openai-bridge.js';
import fs from 'fs';
import path from 'path';

export type AnyObj = Record<string, unknown>;

export function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function collectChatTextMessages(chat: AnyObj): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  const choices = Array.isArray((chat as any).choices) ? ((chat as any).choices as AnyObj[]) : [];
  const primary = choices[0] && typeof choices[0] === 'object' ? choices[0] : ({} as AnyObj);
  const message = asObj(primary.message);
  const role = typeof message.role === 'string' ? message.role : 'assistant';
  const content = (message as any).content;
  const collect = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(collect).join('');
    if (typeof val === 'object') {
      if (typeof (val as any).text === 'string') return String((val as any).text);
      if (Array.isArray((val as any).content)) return collect((val as any).content);
    }
    return '';
  };
  const text = collect(content).trim();
  if (text) out.push({ role, text });
  return out;
}

export function collectSimpleChatView(chat: AnyObj) {
  const model = String((chat as any).model || '');
  const choices = Array.isArray((chat as any).choices) ? ((chat as any).choices as AnyObj[]) : [];
  const primary = choices[0] && typeof choices[0] === 'object' ? choices[0] : ({} as AnyObj);
  const finishReason = typeof primary.finish_reason === 'string' ? primary.finish_reason : '';
  const msgs = collectChatTextMessages(chat);
  const tools = (() => {
    const message = asObj(primary.message);
    const calls = Array.isArray((message as any).tool_calls) ? ((message as any).tool_calls as AnyObj[]) : [];
    return calls.map(tc => ({
      id: String((tc as any).id || ''),
      name: String((tc as any).function?.name || (tc as any).name || ''),
      argsSample: (() => {
        const a = (tc as any).function?.arguments ?? (tc as any).arguments;
        const s = typeof a === 'string' ? a : (() => { try { return JSON.stringify(a ?? {}); } catch { return ''; } })();
        return String(s).slice(0, 80);
      })()
    }));
  })();
  return { model, finishReason, msgs, tools };
}

function collectSimpleResponsesView(resp: AnyObj) {
  const model = String((resp as any).model || '');
  const object = String((resp as any).object || '');
  const status = String((resp as any).status || '');
  const output = Array.isArray((resp as any).output) ? ((resp as any).output as AnyObj[]) : [];
  const outputText = typeof (resp as any).output_text === 'string' ? String((resp as any).output_text) : '';

  const toolCalls: Array<{ name: string; argsSample: string }> = [];
  const requiredAction = asObj((resp as any).required_action);
  const submit = asObj(requiredAction.submit_tool_outputs);
  const calls = Array.isArray(submit.tool_calls) ? (submit.tool_calls as AnyObj[]) : [];
  for (const tc of calls) {
    const fn = asObj((tc as any).function);
    const rawName = fn.name ?? (tc as any).name;
    const name = typeof rawName === 'string' ? rawName : '';
    const rawArgs = fn.arguments ?? (tc as any).arguments;
    const s = typeof rawArgs === 'string'
      ? rawArgs
      : (() => { try { return JSON.stringify(rawArgs ?? {}); } catch { return ''; } })();
    toolCalls.push({ name, argsSample: String(s).slice(0, 80) });
  }

  const outputTypes = output.map(it => String((it as any).type || '')).filter(Boolean);

  return { model, object, status, outputTypes, outputTextSample: outputText.slice(0, 120), toolCalls };
}

export function diffSimpleView(label: string, a: ReturnType<typeof collectSimpleChatView>, b: ReturnType<typeof collectSimpleChatView>): void {
  const diffs: string[] = [];
  if (a.model !== b.model) diffs.push(`model: '${a.model}' → '${b.model}'`);
  if (a.finishReason !== b.finishReason) diffs.push(`finish_reason: '${a.finishReason}' → '${b.finishReason}'`);
  if (a.msgs.length !== b.msgs.length) {
    diffs.push(`msgs.length: ${a.msgs.length} → ${b.msgs.length}`);
  } else {
    for (let i = 0; i < a.msgs.length; i++) {
      if (a.msgs[i].role !== b.msgs[i].role) {
        diffs.push(`msgs[${i}].role: '${a.msgs[i].role}' → '${b.msgs[i].role}'`);
      }
      if (a.msgs[i].text !== b.msgs[i].text) {
        diffs.push(`msgs[${i}].text: '${a.msgs[i].text}' → '${b.msgs[i].text}'`);
      }
    }
  }
  if (a.tools.length !== b.tools.length) {
    diffs.push(`tools.length: ${a.tools.length} → ${b.tools.length}`);
  } else {
    for (let i = 0; i < a.tools.length; i++) {
      if (a.tools[i].name !== b.tools[i].name) {
        diffs.push(`tools[${i}].name: '${a.tools[i].name}' → '${b.tools[i].name}'`);
      }
      if (a.tools[i].argsSample !== b.tools[i].argsSample) {
        diffs.push(`tools[${i}].argsSample: '${a.tools[i].argsSample}' → '${b.tools[i].argsSample}'`);
      }
    }
  }

  if (diffs.length === 0) {
    console.log(`[OK] ${label}: Chat → Responses → Chat 语义等价`);
  } else {
    console.log(`[WARN] ${label}: Chat → Responses → Chat 检测到差异:`);
    for (const d of diffs) console.log('  -', d);
  }
}

function diffChatAndResponses(label: string, chatView: ReturnType<typeof collectSimpleChatView>, respView: ReturnType<typeof collectSimpleResponsesView>): void {
  const diffs: string[] = [];
  if (chatView.model && respView.model && chatView.model !== respView.model) {
    diffs.push(`model: chat='${chatView.model}' responses='${respView.model}'`);
  }
  if (respView.object !== 'response') {
    diffs.push(`object: '${respView.object}' (应为 'response')`);
  }
  if (!respView.status) {
    diffs.push('status 为空（期望为 completed/in_progress）');
  }
  if (chatView.tools.length && !respView.toolCalls.length) {
    diffs.push(`toolCalls 丢失: chat.tools.length=${chatView.tools.length}, responses.toolCalls.length=0`);
  }
  if (!chatView.tools.length && respView.toolCalls.length) {
    diffs.push(`toolCalls 额外出现: chat.tools.length=0, responses.toolCalls.length=${respView.toolCalls.length}`);
  }

  if (diffs.length === 0) {
    console.log(`[OK] ${label}: Chat → Responses 形状与工具映射看起来合理`);
  } else {
    console.log(`[WARN] ${label}: Chat → Responses 检测到差异:`);
    for (const d of diffs) console.log('  -', d);
  }
}

function makeTextOnlyChat(): AnyObj {
  return {
    id: 'chatcmpl-text',
    model: 'gpt-5.1',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '列出本地文件目录' }]
        }
      }
    ]
  };
}

function makeToolCallChat(): AnyObj {
  return {
    id: 'chatcmpl-tools',
    model: 'gpt-5.1',
    usage: { prompt_tokens: 42, completion_tokens: 21, total_tokens: 63 },
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: [],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: JSON.stringify({ path: '.' })
              }
            }
          ]
        }
      }
    ]
  };
}

export function extractChatFromSample(raw: AnyObj): AnyObj {
  try {
    // OpenAI Chat snapshots: data.body.data 层有 choices
    const data = asObj(raw.data as unknown);
    const body = asObj((data as any).body as unknown);
    const inner = asObj((body as any).data as unknown);
    if (Array.isArray((inner as any).choices)) {
      return inner;
    }
  } catch {
    // ignore
  }

  try {
    // Anthropic Messages 等：data.payload
    const data = asObj(raw.data as unknown);
    const payload = asObj((data as any).payload as unknown);
    if (Array.isArray((payload as any).content) || Array.isArray((payload as any).messages)) {
      return payload;
    }
  } catch {
    // ignore
  }

  return raw;
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
      console.warn('[responses-bridge-closed-loop] 加载外部样本失败', p, (e as any)?.message || String(e));
    }
  }
  return out;
}

function writeSnapshot(label: string, payload: {
  chatBefore: AnyObj;
  responses: AnyObj;
  chatAfter: AnyObj;
  viewBefore: ReturnType<typeof collectSimpleChatView>;
  responsesView: ReturnType<typeof collectSimpleResponsesView>;
  viewAfter: ReturnType<typeof collectSimpleChatView>;
}): void {
  try {
    const baseDir = process.env.LLMSWITCH_RESPONSES_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_RESPONSES_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'responses-bridge');
    fs.mkdirSync(baseDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-${safeLabel}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf-8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[responses-bridge-closed-loop] 写入快照失败', (e as any)?.message || String(e));
  }
}

async function runClosedLoopTests(): Promise<void> {
  const cases: Array<{ label: string; chat: AnyObj }> = [];

  // 优先：从环境变量指定的真实样本中加载（逗号分隔的 JSON 文件路径）
  cases.push(...loadChatFixturesFromEnv());

  // 补充：内置的最小样本（文本 + 工具），确保即使外部样本缺失也能跑通
  cases.push(
    { label: 'builtin:text-only', chat: makeTextOnlyChat() },
    { label: 'builtin:tool-call', chat: makeToolCallChat() }
  );

  for (const { label, chat } of cases) {
    console.log(`\n=== Case: ${label} ===`);
    const viewBefore = collectSimpleChatView(chat);

    const ctx: any = { requestId: `test_${label}` };
    const resp = buildResponsesPayloadFromChat(chat, ctx);
    console.log('Responses payload shape keys:', Object.keys(asObj(resp)));

    const respObj = asObj(resp);
    const respView = collectSimpleResponsesView(respObj);

    const back = buildChatResponseFromResponses(respObj) as AnyObj;
    const viewAfter = collectSimpleChatView(back);

    writeSnapshot(label, {
      chatBefore: chat,
      responses: respObj,
      chatAfter: back,
      viewBefore,
      responsesView: respView,
      viewAfter
    });

    diffChatAndResponses(label, viewBefore, respView);
    diffSimpleView(label, viewBefore, viewAfter);
  }
}

// 当作为脚本运行时执行闭环测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runClosedLoopTests().catch(err => {
    console.error('Closed loop test failed:', err);
    process.exit(1);
  });
}
