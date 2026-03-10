/**
 * Anthropic 请求侧闭环测试：AnthropicRequest ↔ ChatRequest
 *
 * 路径：
 *   AnthReq → ChatReq (buildOpenAIChatFromAnthropic)
 *          → AnthReq' (buildAnthropicRequestFromOpenAIChat)
 *
 * 关注点：
 *  - model
 *  - system 文本
 *  - user / assistant 文本
 *  - tools（name/parameters → name/input_schema）的保持
 *
 * 可选：通过 LLMSWITCH_ANTH_REQUEST_FIXTURES 指定真实 Anthropic 请求样本 JSON 文件路径（逗号分隔）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildAnthropicRequestFromOpenAIChat,
} from '../conversion/codecs/anthropic-openai-codec.js';

type AnyObj = Record<string, unknown>;

// 直接复用 codec 内部的 Anthropic→Chat 逻辑
import { AnthropicOpenAIConversionCodec as Codec } from '../conversion/codecs/anthropic-openai-codec.js';

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function collectAnthRequestView(req: AnyObj) {
  const model = String((req as any).model || '');
  const systemBlocks = Array.isArray((req as any).system) ? ((req as any).system as AnyObj[]) : [];
  let systemText = '';
  const collectSystem = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(collectSystem).join('');
    if (typeof val === 'object') {
      if (typeof (val as any).text === 'string') return String((val as any).text);
      if (Array.isArray((val as any).content)) return collectSystem((val as any).content);
    }
    return '';
  };
  for (const b of systemBlocks) {
    const t = collectSystem(b).trim();
    if (t) systemText += (systemText ? '\n' : '') + t;
  }

  const messages = Array.isArray((req as any).messages) ? ((req as any).messages as AnyObj[]) : [];
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  const toolResultIds: string[] = [];
  const tools = Array.isArray((req as any).tools) ? ((req as any).tools as AnyObj[]) : [];
  const toolNames = tools.map(t => String((t as any).name || '')).filter(Boolean);

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
    const role = String((m as any).role || '');
    const content = (m as any).content;
    const text = collectText(content).trim();
    if (role === 'user') {
      if (text) userTexts.push(text);
      // 提取 user 消息中的 tool_result 块的 tool_use_id
      const blocks = Array.isArray(content) ? content as AnyObj[] : [];
      for (const b of blocks) {
        const t = String((b as any).type || '').toLowerCase();
        if (t === 'tool_result') {
          const id =
            (b as any).tool_use_id ||
            (b as any).tool_call_id ||
            (b as any).id ||
            undefined;
          if (id) toolResultIds.push(String(id));
        }
      }
    } else if (role === 'assistant') {
      if (text) assistantTexts.push(text);
    }
  }

  return { model, systemText, userTexts, assistantTexts, toolNames, toolResultIds };
}

function writeSnapshot(label: string, payload: AnyObj) {
  try {
    const baseDir = process.env.LLMSWITCH_ANTH_REQ_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_ANTH_REQ_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'anthropic-request-closed-loop');
    fs.mkdirSync(baseDir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-anth-req-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

function loadAnthropicFixturesFromEnv(): Array<{ label: string; req: AnyObj }> {
  const out: Array<{ label: string; req: AnyObj }> = [];
  const env = String(process.env.LLMSWITCH_ANTH_REQUEST_FIXTURES || '').trim();
  if (!env) return out;
  for (const raw of env.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      const p = path.resolve(raw);
      const txt = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(txt);
      out.push({ label: path.basename(p), req: asObj(j) });
    } catch {
      // ignore
    }
  }
  return out;
}

function loadAnthropicRequestsFromCodexSamples(): Array<{ label: string; req: AnyObj }> {
  const out: Array<{ label: string; req: AnyObj }> = [];
  const baseDir =
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR && process.env.LLMSWITCH_ANTH_SAMPLES_DIR.trim().length > 0
      ? path.resolve(process.env.LLMSWITCH_ANTH_SAMPLES_DIR)
      : path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');
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
        // ignore one bad sample
      }
    }
  } catch {
    // ignore directory errors
  }
  return out;
}

async function runAnthropicRequestClosedLoop() {
  const codec = new Codec({});
  await codec.initialize();

  const cases: Array<{ label: string; req: AnyObj }> = [];

  // 内置简单样本：单 user 文本 + 一两个工具
  const builtin: AnyObj = {
    model: 'chat-model-a',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '列出当前目录下的文件' }]
      }
    ],
    tools: [
      {
        name: 'shell',
        description: 'Run shell commands',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'array', items: { type: 'string' } }
          },
          required: ['command'],
          additionalProperties: false
        }
      }
    ]
  };

  cases.push({ label: 'builtin:anth-request-simple', req: builtin });
  cases.push(...loadAnthropicFixturesFromEnv());
  cases.push(...loadAnthropicRequestsFromCodexSamples());

  for (const { label, req } of cases) {
    console.log(`\n=== Anthropic Request Closed Loop Case: ${label} ===`);
    const viewBefore = collectAnthRequestView(req);

    // AnthReq → ChatReq
    const chatReq = await codec.convertRequest(req, { codec: 'anthropic-openai' } as any, {
      endpoint: 'messages',
      entryEndpoint: '/v1/messages',
      stream: false,
      requestId: label
    } as any);
    const chatObj = asObj(chatReq);

    // ChatReq → AnthReq'
    const anthBack = buildAnthropicRequestFromOpenAIChat(chatObj);
    const viewAfter = collectAnthRequestView(anthBack);

    writeSnapshot(label, {
      anthBefore: req,
      chatReq: chatObj,
      anthAfter: anthBack,
      viewBefore,
      viewAfter
    });

    const sameModel = viewBefore.model === viewAfter.model;
    const sameSystem = viewBefore.systemText === viewAfter.systemText;
    const sameUser = viewBefore.userTexts.join('\n') === viewAfter.userTexts.join('\n');
    const sameTools = viewBefore.toolNames.join(',') === viewAfter.toolNames.join(',');
    const sameToolResults = viewBefore.toolResultIds.join(',') === viewAfter.toolResultIds.join(',');

    const ok = sameModel && sameSystem && sameUser && sameTools && sameToolResults;
    console.log(
      `[anthropic-request-closed-loop] ${label}: ` +
        (ok ? '[OK]' : '[WARN mismatch]'),
      { sameModel, sameSystem, sameUser, sameTools, sameToolResults }
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicRequestClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic request closed loop test failed:', err);
    process.exit(1);
  });
}
