/**
 * Anthropic 回归测试（基于真实快照）：
 *
 * 从 ~/.routecodex/codex-samples/anthropic-messages 下读取 provider 响应快照，
 * 对每一条样本执行：
 *
 *   AnthropicMessage(sample) → AnthropicRequest-like → ChatRequest
 *                         → ChatResponse(fake) → AnthropicMessage'
 *
 * 并检查：
 *   - 文本内容是否在闭环中保持一致；
 *   - 工具调用（tool_use）的名称和参数是否保持一致；
 *   - stop_reason / usage 等关键信息是否合理。
 *
 * 这样可以在不依赖 server 的情况下，对 “Anthropic ↔ Chat” 编解码进行全量回归。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { AnthropicOpenAIConversionCodec as Codec } from '../conversion/codecs/anthropic-openai-codec.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
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

function collectAnthropicMessageView(msg: AnyObj) {
  const model = String((msg as any).model || '');
  const role = String((msg as any).role || '');
  const stopReason = (msg as any).stop_reason ?? null;
  const usage = asObj((msg as any).usage);

  const contentArr = Array.isArray((msg as any).content) ? ((msg as any).content as AnyObj[]) : [];
  let text = '';
  const toolCalls: Array<{ name: string; argsSample: string }> = [];

  for (const block of contentArr) {
    if (!block || typeof block !== 'object') continue;
    const t = String((block as any).type || '').toLowerCase();
    if (t === 'text' && typeof (block as any).text === 'string') {
      const s = (block as any).text;
      if (s && s.trim().length) {
        text += (text ? '\n' : '') + s.trim();
      }
    } else if (t === 'tool_use') {
      const name = typeof (block as any).name === 'string' ? String((block as any).name) : '';
      const input = (block as any).input;
      let argsSample = '';
      if (input != null) {
        try {
          argsSample = JSON.stringify(input).slice(0, 80);
        } catch {
          argsSample = String(input);
        }
      }
      toolCalls.push({ name, argsSample });
    }
  }

  return { model, role, text, toolCalls, stopReason, usage };
}

/**
 * 生成 Anthropic message.content 的“结构签名”，用于在闭环测试中精确对比形状：
 *  - text: { type: 'text', text }
 *  - tool_use: { type: 'tool_use', id, name, input }
 *  - tool_result: { type: 'tool_result', tool_use_id, content }
 *
 * 为了避免被字段顺序干扰，所有对象都会通过 JSON 序列化做一次深拷贝。
 */
function normalizeAnthropicContent(msg: AnyObj): AnyObj[] {
  const contentArr = Array.isArray((msg as any).content) ? ((msg as any).content as AnyObj[]) : [];
  const normBlocks: AnyObj[] = [];

  for (const block of contentArr) {
    if (!block || typeof block !== 'object') continue;
    const t = String((block as any).type || '').toLowerCase();
    if (t === 'text') {
      normBlocks.push({
        type: 'text',
        text: typeof (block as any).text === 'string' ? (block as any).text : ''
      });
    } else if (t === 'tool_use') {
      let inputNorm: unknown = null;
      const input = (block as any).input;
      if (input !== undefined) {
        try {
          inputNorm = JSON.parse(JSON.stringify(input));
        } catch {
          inputNorm = String(input);
        }
      }
      normBlocks.push({
        type: 'tool_use',
        id: (block as any).id ?? null,
        name: typeof (block as any).name === 'string' ? (block as any).name : '',
        input: inputNorm
      });
    } else if (t === 'tool_result') {
      let contentNorm: unknown = null;
      const c = (block as any).content;
      if (c !== undefined) {
        try {
          contentNorm = JSON.parse(JSON.stringify(c));
        } catch {
          contentNorm = String(c);
        }
      }
      normBlocks.push({
        type: 'tool_result',
        tool_use_id:
          (block as any).tool_use_id ??
          (block as any).tool_call_id ??
          (block as any).id ??
          null,
        content: contentNorm
      });
    } else {
      normBlocks.push({ type: t });
    }
  }

  return normBlocks;
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
      : path.resolve(process.cwd(), 'tmp', 'anthropic-snapshot-regression');
    fs.mkdirSync(baseDir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-anth-reg-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf8');
  } catch {
    // ignore snapshot errors
  }
}

async function runAnthropicSnapshotClosedLoop() {
  const codec = new Codec({});
  await codec.initialize();

  const baseDir =
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR &&
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR.trim().length > 0
      ? path.resolve(process.env.LLMSWITCH_ANTH_SAMPLES_DIR)
      : path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');

  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
    // eslint-disable-next-line no-console
    console.warn('[anthropic-snapshot-closed-loop] samples dir not found:', baseDir);
    return;
  }

  const files = fs.readdirSync(baseDir).filter(f =>
    f.endsWith('_pipeline.provider.response.post.json')
  );

  if (!files.length) {
    // eslint-disable-next-line no-console
    console.warn('[anthropic-snapshot-closed-loop] no provider.response.post snapshots in:', baseDir);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[anthropic-snapshot-closed-loop] running on ${files.length} samples from ${baseDir}`
  );

  let passed = 0;
  let warned = 0;

  for (const file of files) {
    const full = path.join(baseDir, file);
    const raw = safeReadJson(full);
    if (!raw) {
      // eslint-disable-next-line no-console
      console.warn('[anthropic-snapshot-closed-loop] skip invalid JSON:', file);
      continue;
    }
    const data = asObj(raw.data);
    const payload = asObj(data.payload);
    const inner = asObj(payload.data);

    const label = path.basename(file, '.json');

    // 只接受 Anthropic Message 形状
    if (String(inner.type || '').toLowerCase() !== 'message') {
      continue;
    }

    const anthMsg = inner;
    const viewBefore = collectAnthropicMessageView(anthMsg);

    // AnthropicMessage → AnthropicRequest-like → ChatRequest
    const anthReqLike: AnyObj = {
      model: anthMsg.model,
      messages: [
        {
          role: anthMsg.role,
          content: anthMsg.content
        }
      ]
    };
    const profileReq: any = { id: 'anthropic-standard', from: 'anthropic-messages', to: 'openai-chat' };
    const ctxReq: any = {
      endpoint: 'anthropic',
      entryEndpoint: '/v1/messages',
      stream: false,
      requestId: label
    };
    const chatReq = asObj(await codec.convertRequest(anthReqLike, profileReq, ctxReq));
    const viewChat = collectChatRequestView(chatReq);

    // ChatRequest → 伪 ChatResponse → AnthropicMessage'
    // 根据原始 stop_reason 反推 OpenAI Chat 的 finish_reason，
    // 以便与 buildAnthropicFromOpenAIChat 中的映射形成闭环：
    //   tool_use      → tool_calls
    //   max_tokens    → length
    //   stop_sequence → content_filter
    //   其他 / end_turn → stop
    const toOpenAIFinishReason = (sr: unknown): string => {
      const v = String(sr || '');
      if (v === 'tool_use') return 'tool_calls';
      if (v === 'max_tokens') return 'length';
      if (v === 'stop_sequence') return 'content_filter';
      return 'stop';
    };

    const fakeChatResp: AnyObj = {
      id: `chatcmpl_${label}`,
      object: 'chat.completion',
      model: chatReq.model || anthMsg.model,
      choices: [
        {
          index: 0,
          finish_reason: toOpenAIFinishReason(viewBefore.stopReason),
          message:
            Array.isArray(chatReq.messages) && chatReq.messages.length
              ? chatReq.messages[chatReq.messages.length - 1]
              : { role: 'assistant', content: viewChat.assistantText }
        }
      ],
      usage: {}
    };

    const profileResp: any = { id: 'anthropic-standard', from: 'openai-chat', to: 'anthropic-messages' };
    const ctxResp: any = {
      endpoint: 'anthropic',
      entryEndpoint: '/v1/messages',
      stream: false,
      requestId: `${label}_back`
    };
    const anthMsgBack = asObj(await codec.convertResponse(fakeChatResp, profileResp, ctxResp));
    const viewAfter = collectAnthropicMessageView(anthMsgBack);

    const normContentBefore = normalizeAnthropicContent(anthMsg);
    const normContentAfter = normalizeAnthropicContent(anthMsgBack);

    const sameText = viewBefore.text === viewAfter.text;
    const sameToolNames =
      viewBefore.toolCalls.map(t => t.name).join(',') ===
      viewAfter.toolCalls.map(t => t.name).join(',');
    const sameStopReason = String(viewBefore.stopReason || '') === String(viewAfter.stopReason || '');

    const sameContent =
      JSON.stringify(normContentBefore) === JSON.stringify(normContentAfter);

    // 约束：text / tool_use 名称 / stop_reason / content 结构四者必须保持一致，
    // 这样可以避免类似“tool_use 被丢弃、text block 形状被破坏或 stop_reason 变成 null”的静默错误。
    const ok = sameText && sameToolNames && sameStopReason && sameContent;
    if (ok) passed += 1;
    else warned += 1;

    writeSnapshot(label, {
      anthBefore: anthMsg,
      anthAfter: anthMsgBack,
      viewBefore,
      viewChat,
      viewAfter,
      sameText,
      sameToolNames,
      sameStopReason,
      sameContent,
      normContentBefore,
      normContentAfter
    });

    // eslint-disable-next-line no-console
    console.log(
      `[anthropic-snapshot-closed-loop] ${label}: ` +
        (ok ? '[OK]' : '[WARN text/tool mismatch]'),
      {
        textEq: sameText,
        toolEq: sameToolNames,
        modelBefore: viewBefore.model,
        modelAfter: viewAfter.model
      }
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[anthropic-snapshot-closed-loop] summary: passed=${passed}, warned=${warned}, total=${passed +
      warned}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicSnapshotClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic snapshot closed loop test failed:', err);
    process.exit(1);
  });
}
