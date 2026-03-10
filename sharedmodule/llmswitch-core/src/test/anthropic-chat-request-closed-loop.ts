/**
 * Anthropic Chat 入口闭环测试（Chat→Anth→Chat）：
 *
 * 针对实际流水线在 /v1/messages 入口时，已经位于 Chat 段的请求：
 *   ChatRequest(pipeline.llmswitch.request.post.payload)
 *     → AnthropicRequest(buildAnthropicRequestFromOpenAIChat)
 *     → ChatRequest'(codec.convertRequest)
 *
 * 目标：
 *  - 在 Chat 视角下，model / messages / tools 的核心语义保持不变；
 *  - 验证 buildAnthropicRequestFromOpenAIChat 与 AnthropicOpenAIConversionCodec.convertRequest
 *    组合在“实际 Claudecode 形状样本”上闭环。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { AnthropicOpenAIConversionCodec as Codec, buildAnthropicRequestFromOpenAIChat } from '../conversion/codecs/anthropic-openai-codec.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function collectChatRequestView(chatReq: AnyObj) {
  const model = String((chatReq as any).model || '');
  const messages = Array.isArray((chatReq as any).messages) ? ((chatReq as any).messages as AnyObj[]) : [];
  const tools = Array.isArray((chatReq as any).tools) ? ((chatReq as any).tools as AnyObj[]) : [];

  const roles: string[] = [];
  const texts: string[] = [];
  const toolNames: string[] = [];

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
    roles.push(role);
    const content = (m as any).content;
    const t = collectText(content).trim();
    if (t) texts.push(`${role}:${t.slice(0, 80)}`);
  }

  for (const t of tools) {
    const fn = (t as any).function || {};
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (name) toolNames.push(name);
  }

  return { model, roles, texts, toolNames };
}

function safeReadJson(file: string): AnyObj | null {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(txt);
    return asObj(j);
  } catch {
    return null;
  }
}

function loadChatRequestsFromPipelineSnapshots(): Array<{ label: string; chat: AnyObj }> {
  const out: Array<{ label: string; chat: AnyObj }> = [];
  const baseDir =
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR &&
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR.trim().length > 0
      ? path.resolve(process.env.LLMSWITCH_ANTH_SAMPLES_DIR)
      : path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');

  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
    return out;
  }

  const files = fs
    .readdirSync(baseDir)
    .filter(f => f.endsWith('_pipeline.llmswitch.request.post.json'));

  for (const f of files) {
    try {
      const full = path.join(baseDir, f);
      const raw = safeReadJson(full);
      if (!raw) continue;
      const data = asObj(raw.data);
      const payload = asObj(data.payload);
      out.push({ label: f, chat: payload });
    } catch {
      // ignore one bad sample
    }
  }

  return out;
}

function writeSnapshot(label: string, payload: AnyObj) {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const baseDir = process.env.LLMSWITCH_ANTH_REQ_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_ANTH_REQ_SNAPSHOT_DIR)
      : path.resolve(__dirname, '../../../tmp', 'anthropic-chat-request-closed-loop');
    fs.mkdirSync(baseDir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-anth-chat-req-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf8');
  } catch {
    // ignore snapshot errors
  }
}

async function runAnthropicChatRequestClosedLoop() {
  const codec = new Codec({});
  await codec.initialize();

  const cases: Array<{ label: string; chat: AnyObj }> = [];

  // 内置简单样本：单 user 文本 + 无工具
  cases.push({
    label: 'builtin:chat-request-simple',
    chat: {
      model: 'chat-model-a',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '列出当前目录下的文件' }
      ],
      tools: []
    } as AnyObj
  });

  cases.push(...loadChatRequestsFromPipelineSnapshots());

  for (const { label, chat } of cases) {
    // eslint-disable-next-line no-console
    console.log(`\n=== Anthropic Chat Request Closed Loop Case: ${label} ===`);
    const viewBefore = collectChatRequestView(chat);

    // ChatReq → AnthReq
    const anthReq = buildAnthropicRequestFromOpenAIChat(chat);

    // AnthReq → ChatReq'
    const profile: any = { id: 'anthropic-standard', from: 'anthropic-messages', to: 'openai-chat' };
    const ctxReq: any = {
      endpoint: 'anthropic',
      entryEndpoint: '/v1/messages',
      stream: false,
      requestId: `${label}_back`
    };
    const chatBack = asObj(await codec.convertRequest(anthReq, profile, ctxReq));
    const viewAfter = collectChatRequestView(chatBack);

    writeSnapshot(label, {
      chatBefore: chat,
      anthReq,
      chatAfter: chatBack,
      viewBefore,
      viewAfter
    });

    const sameModel = viewBefore.model === viewAfter.model;
    const sameRoles = viewBefore.roles.join(',') === viewAfter.roles.join(',');
    const sameText = viewBefore.texts.join('\n') === viewAfter.texts.join('\n');
    const sameTools = viewBefore.toolNames.join(',') === viewAfter.toolNames.join(',');

    const ok = sameModel && sameRoles && sameText && sameTools;

    // eslint-disable-next-line no-console
    console.log(
      `[anthropic-chat-request-closed-loop] ${label}: ` + (ok ? '[OK]' : '[WARN mismatch]'),
      { sameModel, sameRoles, sameText, sameTools }
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicChatRequestClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic chat request closed loop test failed:', err);
    process.exit(1);
  });
}

