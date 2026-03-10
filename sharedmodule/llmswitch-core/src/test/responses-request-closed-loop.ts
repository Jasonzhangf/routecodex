/**
 * Responses 请求侧闭环测试：ResponsesRequest ↔ ChatRequest
 *
 * 路径：
 *   ResponsesReq → ChatReq (buildChatRequestFromResponses)
 *              → ResponsesReq' (buildResponsesRequestFromChat)
 *
 * 关注点：
 *  - model
 *  - user 文本（input[].message vs chat.messages）
 *  - 工具调用（function_call 输入块 vs chat.messages[].tool_calls）
 *
 * 可选：通过 LLMSWITCH_RESPONSES_REQUEST_FIXTURES 指定真实样本 JSON 文件路径（逗号分隔）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildResponsesRequestFromChat, captureResponsesContext, buildChatRequestFromResponses } from '../conversion/responses/responses-openai-bridge.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function collectSimpleResponsesView(req: AnyObj) {
  const model = String((req as any).model || '');
  const input = Array.isArray(req.input) ? (req.input as AnyObj[]) : [];
  const userTexts: string[] = [];
  const toolCalls: Array<{ name: string; argsSample: string }> = [];

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

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const t = String((entry as any).type || '').toLowerCase();
    if (t === 'function_call' || t === 'tool_call') {
      const rawName = (entry as any).name || (entry as any)?.function?.name;
      const name = typeof rawName === 'string' ? rawName : '';
      const rawArgs = (entry as any)?.arguments ?? (entry as any)?.function?.arguments;
      const s = typeof rawArgs === 'string'
        ? rawArgs
        : (() => { try { return JSON.stringify(rawArgs ?? {}); } catch { return ''; } })();
      toolCalls.push({ name, argsSample: String(s).slice(0, 80) });
      continue;
    }
    const role = String((entry as any).role || '').toLowerCase();
    if (role === 'user') {
      const msg = asObj((entry as any).message);
      const content = (msg as any).content ?? (entry as any).content;
      const text = collectText(content).trim();
      if (text) userTexts.push(text);
    }
  }

  return { model, userTexts, toolCalls };
}

function collectSimpleChatReqView(chat: AnyObj) {
  const model = String((chat as any).model || '');
  const messages = Array.isArray(chat.messages) ? (chat.messages as AnyObj[]) : [];
  const userTexts: string[] = [];
  const toolCalls: Array<{ name: string; argsSample: string }> = [];

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
    const role = String((m as any).role || '').toLowerCase();
    if (role === 'user') {
      const text = collectText((m as any).content).trim();
      if (text) userTexts.push(text);
    }
    const calls = Array.isArray((m as any).tool_calls) ? ((m as any).tool_calls as AnyObj[]) : [];
    for (const tc of calls) {
      const rawName = (tc as any)?.function?.name || (tc as any).name;
      const name = typeof rawName === 'string' ? rawName : '';
      const rawArgs = (tc as any)?.function?.arguments ?? (tc as any).arguments;
      const s = typeof rawArgs === 'string'
        ? rawArgs
        : (() => { try { return JSON.stringify(rawArgs ?? {}); } catch { return ''; } })();
      toolCalls.push({ name, argsSample: String(s).slice(0, 80) });
    }
  }

  return { model, userTexts, toolCalls };
}

function diffRequestView(label: string, a: ReturnType<typeof collectSimpleResponsesView>, b: ReturnType<typeof collectSimpleResponsesView>): void {
  const diffs: string[] = [];
  if (a.model !== b.model) diffs.push(`model: '${a.model}' → '${b.model}'`);
  if (a.userTexts.length !== b.userTexts.length) {
    diffs.push(`userTexts.length: ${a.userTexts.length} → ${b.userTexts.length}`);
  } else {
    for (let i = 0; i < a.userTexts.length; i++) {
      if (a.userTexts[i] !== b.userTexts[i]) {
        diffs.push(`userTexts[${i}]: '${a.userTexts[i]}' → '${b.userTexts[i]}'`);
      }
    }
  }
  if (a.toolCalls.length !== b.toolCalls.length) {
    diffs.push(`toolCalls.length: ${a.toolCalls.length} → ${b.toolCalls.length}`);
  } else {
    for (let i = 0; i < a.toolCalls.length; i++) {
      if (a.toolCalls[i].name !== b.toolCalls[i].name) {
        diffs.push(`toolCalls[${i}].name: '${a.toolCalls[i].name}' → '${b.toolCalls[i].name}'`);
      }
      if (a.toolCalls[i].argsSample !== b.toolCalls[i].argsSample) {
        diffs.push(`toolCalls[${i}].argsSample: '${a.toolCalls[i].argsSample}' → '${b.toolCalls[i].argsSample}'`);
      }
    }
  }

  if (diffs.length === 0) {
    console.log(`[OK] ${label}: ResponsesReq → ChatReq → ResponsesReq' 语义等价`);
  } else {
    console.log(`[WARN] ${label}: 请求闭环检测到差异:`);
    for (const d of diffs) console.log('  -', d);
  }
}

/**
 * 针对 Responses 请求的最小 schema 校验（偏向 FC /responses 形状），用于在闭环测试阶段尽早暴露问题：
 *  - message 输入块必须存在 content 数组；
 *  - function_call 输入块必须包含 call_id，不应包含 role/message；
 *  - 对于 FC 风格的请求，function_call.id / call_id 需要以 'fc' 开头（以便尽早发现未加前缀的问题）；
 *  - function_call_output 必须包含 call_id，且应当能在同一请求中找到对应的 function_call（即成对出现）。
 */
function validateResponsesSchema(label: string, req: AnyObj): void {
  const input = Array.isArray((req as any).input) ? ((req as any).input as AnyObj[]) : [];
  const schemaIssues: string[] = [];
  const functionCallIds = new Set<string>();
  const outputCallIds = new Set<string>();

  input.forEach((entry, idx) => {
    const t = String((entry as any).type || '').toLowerCase();
    if (t === 'message') {
      const content = (entry as any).content;
      if (!Array.isArray(content) || content.length === 0) {
        schemaIssues.push(`input[${idx}]: message 缺少 content 数组或为空`);
      }
    }
    if (t === 'function_call') {
      const callId = (entry as any).call_id || (entry as any).id;
      if (typeof callId !== 'string' || !callId) {
        schemaIssues.push(`input[${idx}]: function_call 缺少 call_id`);
      } else {
        functionCallIds.add(String(callId));
      }
      if ((entry as any).role !== undefined) {
        schemaIssues.push(`input[${idx}]: function_call 不应包含 role 字段`);
      }
      if ((entry as any).message !== undefined) {
        schemaIssues.push(`input[${idx}]: function_call 不应包含 message 字段`);
      }
    }
    if (t === 'function_call_output') {
      const callId = (entry as any).call_id || (entry as any).id;
      if (typeof callId !== 'string' || !callId) {
        schemaIssues.push(`input[${idx}]: function_call_output 缺少 call_id`);
      } else {
        outputCallIds.add(String(callId));
      }
    }
  });

  // 成对性检查：所有 function_call 应该能在同一请求中找到至少一个对应的 function_call_output
  for (const id of functionCallIds) {
    if (!outputCallIds.has(id)) {
      schemaIssues.push(`配对检查: function_call '${id}' 在同一请求中未找到对应的 function_call_output`);
    }
  }

  if (schemaIssues.length) {
    console.log(`[WARN] ${label}: Responses 请求 schema 检查发现问题:`);
    for (const issue of schemaIssues) console.log('  -', issue);
  } else {
    console.log(`[OK] ${label}: Responses 请求 schema 通过（input[*] 结构看起来合理）`);
  }
}

function writeSnapshot(label: string, payload: {
  responsesBefore: AnyObj;
  chat: AnyObj;
  responsesAfter: AnyObj;
  viewBefore: ReturnType<typeof collectSimpleResponsesView>;
  viewAfter: ReturnType<typeof collectSimpleResponsesView>;
}): void {
  try {
    const baseDir = process.env.LLMSWITCH_RESPONSES_REQ_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_RESPONSES_REQ_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'responses-request');
    fs.mkdirSync(baseDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-req-${safeLabel}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf-8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[responses-request-closed-loop] 写入快照失败', (e as any)?.message || String(e));
  }
}

function collectCallIdsFromRequest(req: AnyObj): string[] {
  const collected: string[] = [];
  const input = Array.isArray((req as any).input) ? ((req as any).input as AnyObj[]) : [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const t = String((entry as any).type || '').toLowerCase();
    if (t === 'function_call' || t === 'function_call_output' || t === 'tool_result' || t === 'tool_message') {
      const callId =
        (entry as any).call_id ||
        (entry as any).tool_call_id ||
        (entry as any).id;
      if (typeof callId === 'string' && callId.trim().length) {
        collected.push(callId.trim());
      }
    }
  }
  return collected;
}

function ensureCallIdsPreserved(label: string, before: AnyObj, after: AnyObj): void {
  const original = new Set(collectCallIdsFromRequest(before));
  if (!original.size) return;
  const roundtrip = new Set(collectCallIdsFromRequest(after));
  const missing = Array.from(original).filter((id) => !roundtrip.has(id));
  if (missing.length) {
    console.log(`[WARN] ${label}: call_id 在回环过程中发生变化: ${missing.join(', ')}`);
  } else {
    console.log(`[OK] ${label}: call_id 保持不变`);
  }
}

function loadResponsesFixturesFromEnv(): Array<{ label: string; req: AnyObj }> {
  const out: Array<{ label: string; req: AnyObj }> = [];
  const raw = process.env.LLMSWITCH_RESPONSES_REQUEST_FIXTURES;
  if (!raw) return out;
  const paths = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of paths) {
    try {
      const txt = fs.readFileSync(p, 'utf-8');
      const loaded = JSON.parse(txt) as any;
      if (loaded && typeof loaded === 'object') {
        // 同时兼容“裸 Responses 请求”和 provider-request 快照（包含 data.body）的结构
        const maybeBody = loaded?.data && typeof loaded.data === 'object' ? (loaded.data as any).body : undefined;
        const req = maybeBody && typeof maybeBody === 'object' ? maybeBody : loaded;
        out.push({ label: `fixture:${p}`, req: asObj(req) });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[responses-request-closed-loop] 加载外部样本失败', p, (e as any)?.message || String(e));
    }
  }
  return out;
}

function loadResponsesRequestsFromCodexSamples(): Array<{ label: string; req: AnyObj }> {
  const out: Array<{ label: string; req: AnyObj }> = [];
  const baseDirEnv = process.env.LLMSWITCH_RESPONSES_REQUEST_SAMPLES_DIR;
  const baseDir = baseDirEnv && baseDirEnv.trim().length > 0
    ? path.resolve(baseDirEnv)
    : path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
  try {
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
      return out;
    }
    const files = fs.readdirSync(baseDir).filter(f => f.endsWith('_server-pre-process.json'));
    for (const f of files) {
      try {
        const full = path.join(baseDir, f);
        const txt = fs.readFileSync(full, 'utf8');
        const j = JSON.parse(txt);
        const data = asObj((j as any).data);
        const orig = asObj((data as any).originalData ?? (data as any).payload ?? j);
        out.push({ label: f, req: orig });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return out;
}

function makeSimpleResponsesRequest(): AnyObj {
  return {
    model: 'gpt-5.1',
    instructions: '你是一个简短助手',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '列出本地文件目录' }
        ]
      }
    ]
  };
}

function makeFunctionCallResponsesRequest(): AnyObj {
  const callId = 'fc_call_builtin_fc_1';
  return {
    model: 'gpt-5.1',
    instructions: '你是一个简短助手（带函数调用）',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '列出当前目录下的文件' }]
      },
      {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['ls'], timeout_ms: 10000 }),
        call_id: callId,
        id: callId
      },
      {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({
          output: 'file1\nfile2\n',
          metadata: { exit_code: 0, duration_seconds: 0.1 }
        })
      }
    ]
  };
}

function makeProviderStyleFunctionCallRequest(): AnyObj {
  const callId = 'shell_command:25';
  return {
    model: 'kimi-for-coding',
    instructions: '你是 RouteCodex Responses provider，保持工具 call_id 原样。',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '列出 electron/forge 配置' }]
      },
      {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({ command: 'ls configs', timeout_ms: 5000 }),
        call_id: callId,
        id: callId
      },
      {
        type: 'function_call_output',
        call_id: callId,
        output: 'configs/electron-forge.config.js'
      }
    ]
  };
}

function validateNoMetadataReasoningFallback(): void {
  const req: AnyObj = {
    model: 'gpt-5.1',
    instructions: '只回复 OK',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }]
      }
    ]
  };
  const ctx = captureResponsesContext(req, { route: { requestId: 'req_metadata_reasoning_guard' } }) as AnyObj;
  const metadata = (ctx.metadata && typeof ctx.metadata === 'object') ? (ctx.metadata as AnyObj) : {};
  metadata.__rcc_reasoning_instructions_segments = ['META_REASONING_SEGMENT_SHOULD_NOT_APPEAR'];
  ctx.metadata = metadata;
  if (Object.prototype.hasOwnProperty.call(ctx, '__rcc_reasoning_instructions_segments')) {
    delete (ctx as AnyObj).__rcc_reasoning_instructions_segments;
  }

  const chatRes = buildChatRequestFromResponses(req, ctx as any);
  const chatReq = asObj(chatRes.request);
  const respBack = buildResponsesRequestFromChat(chatReq, ctx as any).request as AnyObj;
  const instructions = String((respBack as any).instructions || '');

  if (instructions.includes('META_REASONING_SEGMENT_SHOULD_NOT_APPEAR')) {
    console.log('[WARN] metadata reasoning fallback still active: instructions leaked metadata segments');
  } else {
    console.log('[OK] metadata reasoning fallback removed: instructions did not include metadata segments');
  }
}

async function runRequestClosedLoopTests(): Promise<void> {
  const cases: Array<{ label: string; req: AnyObj }> = [];

  cases.push(...loadResponsesFixturesFromEnv());
  cases.push(...loadResponsesRequestsFromCodexSamples());
  cases.push({ label: 'builtin:simple-request', req: makeSimpleResponsesRequest() });
  cases.push({ label: 'builtin:function-call-request', req: makeFunctionCallResponsesRequest() });
  cases.push({ label: 'builtin:provider-style-function-call', req: makeProviderStyleFunctionCallRequest() });

  for (const { label, req } of cases) {
    console.log(`\n=== Request Case: ${label} ===`);
    const viewBefore = collectSimpleResponsesView(req);

    const ctx = captureResponsesContext(req, { route: { requestId: `req_${label}` } });
    const chatRes = buildChatRequestFromResponses(req, ctx);
    const chatReq = asObj(chatRes.request);
    const viewChat = collectSimpleChatReqView(chatReq);
    console.log('ChatReq view:', viewChat);

    const respBack = buildResponsesRequestFromChat(chatReq).request;
    const viewAfter = collectSimpleResponsesView(respBack);

    writeSnapshot(label, {
      responsesBefore: req,
      chat: chatReq,
      responsesAfter: respBack,
      viewBefore,
      viewAfter
    });

    diffRequestView(label, viewBefore, viewAfter);
    // 针对回环后的 Responses 请求做一次 schema 检查（引入 provider 约束）
    validateResponsesSchema(label, respBack);
    ensureCallIdsPreserved(label, req, respBack);
  }

  validateNoMetadataReasoningFallback();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRequestClosedLoopTests().catch(err => {
    console.error('Request closed loop test failed:', err);
    process.exit(1);
  });
}
