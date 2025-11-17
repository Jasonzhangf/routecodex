#!/usr/bin/env node
/**
 * Anthropic 对比工具：直通 vs 编解码
 *
 * 用途：
 *   - 从 codex-samples 中读取一条 Anthropic 请求/响应样本；
 *   - 在 llmswitch-core 内部模拟两条路径：
 *       A) passthrough: AnthReq/AnthResp 原样视为 canonical；
 *       B) chat: AnthReq → Chat → AnthReq' / AnthResp → Chat → AnthResp'；
 *   - 打印两条路径在“进入 provider 前的请求形状”和“HTTP 返回前的响应形状”上的差异。
 *
 * 使用示例：
 *   node scripts/anthropic-compare-modes.mjs \\
 *     --request ~/.routecodex/codex-samples/anthropic-messages/req_xxx_server-pre-process.json \\
 *     --response ~/.routecodex/codex-samples/anthropic-messages/req_xxx_pipeline.provider.response.post.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function asObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function loadJson(p) {
  const txt = fs.readFileSync(p, 'utf8');
  return JSON.parse(txt);
}

function extractAnthRequestFromServerPre(file) {
  const j = loadJson(file);
  const data = asObj(j.data);
  const orig = asObj(data.originalData ?? data.payload ?? j);
  return orig;
}

function extractAnthResponseFromProviderPost(file) {
  const j = loadJson(file);
  const data = asObj(j.data);
  const payload = asObj(data.payload ?? data);
  const inner = asObj(payload.data ?? payload);
  return inner;
}

function viewRequestAnth(req) {
  const out = {};
  out.model = String(req.model || '');
  out.hasSystem = Array.isArray(req.system) && req.system.length > 0;
  out.messageRoles = Array.isArray(req.messages)
    ? req.messages.map(m => String(m.role || ''))
    : [];
  out.hasTools = Array.isArray(req.tools) && req.tools.length > 0;
  out.toolNames = Array.isArray(req.tools)
    ? req.tools.map(t => String(t.name || '')).filter(Boolean)
    : [];
  return out;
}

function viewResponseAnth(resp) {
  const out = {};
  out.id = String(resp.id || '');
  out.model = String(resp.model || '');
  out.role = String(resp.role || '');
  out.stop_reason = String(resp.stop_reason || '');
  const content = Array.isArray(resp.content) ? resp.content : [];
  out.blockTypes = content.map(b => String(b.type || ''));
  out.hasToolUse = content.some(b => String(b.type || '').toLowerCase() === 'tool_use');
  out.hasToolResult = content.some(b => String(b.type || '').toLowerCase() === 'tool_result');
  return out;
}

function diffViews(label, a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const diffs = [];
  for (const k of keys) {
    const av = JSON.stringify(a?.[k]);
    const bv = JSON.stringify(b?.[k]);
    if (av !== bv) {
      diffs.push({ field: k, a: a?.[k], b: b?.[k] });
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log('A (passthrough view):', a);
  console.log('B (chat bridge view):', b);
  if (!diffs.length) {
    console.log('[OK] views identical');
  } else {
    console.log('[DIFF]', diffs);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let reqFile = '';
  let respFile = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--request') reqFile = args[++i];
    else if (args[i] === '--response') respFile = args[++i];
  }
  if (!reqFile || !respFile) {
    console.error('Usage: node scripts/anthropic-compare-modes.mjs --request <server-pre> --response <provider-response.post>');
    process.exit(2);
  }
  reqFile = path.resolve(reqFile);
  respFile = path.resolve(respFile);

  const anthReq = extractAnthRequestFromServerPre(reqFile);
  const anthResp = extractAnthResponseFromProviderPost(respFile);

  // 动态引入 llmswitch-core（优先 vendor）
  const root = path.resolve(__dirname, '..');
  const vendor = path.join(root, 'vendor', 'rcc-llmswitch-core', 'dist');
  const coreMod = await import(url.pathToFileURL(path.join(vendor, 'v2', 'conversion', 'codecs', 'anthropic-openai-codec.js')).href);
  const Codec = coreMod.AnthropicOpenAIConversionCodec;
  const buildAnthReq = coreMod.buildAnthropicRequestFromOpenAIChat;

  const codec = new Codec({});
  await codec.initialize();

  // 请求：A 直通 vs B 编解码
  const chatReqReqSide = await codec.convertRequest(anthReq, { codec: 'anthropic-openai' }, {
    endpoint: 'messages',
    entryEndpoint: '/v1/messages',
    stream: false,
    requestId: 'compare-req'
  });
  const anthReqChat = buildAnthReq(chatReqReqSide);

  const viewReqA = viewRequestAnth(anthReq);
  const viewReqB = viewRequestAnth(anthReqChat);
  diffViews('REQUEST COMPARISON', viewReqA, viewReqB);

  // 响应：A 直通 vs B 编解码
  // 使用与 anthropic-snapshot-closed-loop 相同路径：
  // AnthResp -> AnthReq-like -> ChatReq -> fake ChatResp -> AnthResp'
  const anthReqLike = {
    model: anthResp.model,
    messages: [
      {
        role: anthResp.role,
        content: anthResp.content
      }
    ]
  };

  const profileReq = { id: 'anthropic-standard', from: 'anthropic-messages', to: 'openai-chat' };
  const ctxReq = {
    endpoint: 'anthropic',
    entryEndpoint: '/v1/messages',
    stream: false,
    requestId: 'compare-resp-req'
  };
  const chatReqRespSide = await codec.convertRequest(anthReqLike, profileReq, ctxReq);

  const mapStopToFinish = (sr) => {
    const v = String(sr || '');
    if (v === 'tool_use') return 'tool_calls';
    if (v === 'max_tokens') return 'length';
    if (v === 'stop_sequence') return 'content_filter';
    return 'stop';
  };

  const fakeChatResp = {
    id: `chatcmpl_compare_${Date.now()}`,
    object: 'chat.completion',
    model: chatReqRespSide.model || anthResp.model,
    choices: [
      {
        index: 0,
        finish_reason: mapStopToFinish(anthResp.stop_reason),
        message: Array.isArray(chatReqRespSide.messages) && chatReqRespSide.messages.length
          ? chatReqRespSide.messages[chatReqRespSide.messages.length - 1]
          : { role: 'assistant', content: '' }
      }
    ],
    usage: {}
  };

  const profileResp = { id: 'anthropic-standard', from: 'openai-chat', to: 'anthropic-messages' };
  const ctxResp = {
    endpoint: 'anthropic',
    entryEndpoint: '/v1/messages',
    stream: false,
    requestId: 'compare-resp-back'
  };
  const anthRespChat = await codec.convertResponse(fakeChatResp, profileResp, ctxResp);

  const viewRespA = viewResponseAnth(anthResp);
  const viewRespB = viewResponseAnth(anthRespChat);
  diffViews('RESPONSE COMPARISON', viewRespA, viewRespB);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('anthropic-compare-modes failed:', err);
    process.exit(1);
  });
}
