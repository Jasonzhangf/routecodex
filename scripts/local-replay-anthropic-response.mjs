#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  convertAnthropicRequest,
  convertAnthropicResponse,
} from './helpers/anthropic-codec-direct-native.mjs';

async function pickLatestFinalizePre() {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  try {
    const entries = await fs.readdir(dir);
    const files = entries
      .filter(n => n.endsWith('_finalize-pre.json'))
      .map(n => path.join(dir, n));
    const stats = await Promise.all(files.map(async f => ({ f, t: (await fs.stat(f)).mtimeMs })));
    stats.sort((a,b)=>a.t - b.t);
    return stats.length ? stats[stats.length-1].f : null;
  } catch {
    return null;
  }
}

async function main() {
  // Input: OpenAI-shaped provider response, or a snapshot wrapper containing inputData
  const respFile = process.argv[2] || await pickLatestFinalizePre();
  const outDir = process.argv[3] || path.join(process.cwd(), 'test-results', 'anthropic-replay');
  if (!respFile) { console.error('No anthropic finalize-pre or response file found'); process.exit(1); }

  await fs.mkdir(outDir, { recursive: true });
  if (!process.env.RCC_SNAPSHOT_DIR) process.env.RCC_SNAPSHOT_DIR = path.join(outDir, 'snapshots');
  if (!process.env.RCC_FILTER_SNAPSHOT) process.env.RCC_FILTER_SNAPSHOT = '1';

  const txt = await fs.readFile(respFile, 'utf-8');
  const wrap = JSON.parse(txt);
  const anthMsg = wrap?.inputData || wrap?.data || wrap; // Anthropic message shape
  const requestId = (wrap?.context?.requestId) || wrap?.requestId || `anthres_${Date.now()}`;

  // 按 v3 回环测试同样路径执行：
  // AnthropicMessage -> AnthReq-like -> ChatRequest -> fake ChatResponse -> AnthropicMessage'
  const anthReqLike = {
    model: anthMsg.model,
    messages: [
      {
        role: anthMsg.role,
        content: anthMsg.content
      }
    ]
  };

  const ctxReq = {
    endpoint: 'anthropic',
    entryEndpoint: '/v1/messages',
    stream: false,
    requestId
  };
  const chatReq = convertAnthropicRequest(anthReqLike, ctxReq);

  const mapStopToFinish = (sr) => {
    const v = String(sr || '');
    if (v === 'tool_use') return 'tool_calls';
    if (v === 'max_tokens') return 'length';
    if (v === 'stop_sequence') return 'content_filter';
    return 'stop';
  };

  const fakeChatResp = {
    id: `chatcmpl_${requestId}`,
    object: 'chat.completion',
    model: chatReq.model || anthMsg.model,
    choices: [
      {
        index: 0,
        finish_reason: mapStopToFinish(anthMsg.stop_reason),
        message: Array.isArray(chatReq.messages) && chatReq.messages.length
          ? chatReq.messages[chatReq.messages.length - 1]
          : { role: 'assistant', content: '' }
      }
    ],
    usage: {}
  };

  const ctxResp = {
    endpoint: 'anthropic',
    entryEndpoint: '/v1/messages',
    stream: false,
    requestId: `${requestId}_back`
  };

  const normalized = convertAnthropicResponse(fakeChatResp, ctxResp);
  const outPath = path.join(outDir, `replay_${requestId}_convertResponse.json`);
  await fs.writeFile(outPath, JSON.stringify(normalized, null, 2), 'utf-8');
  console.log('Anthropic convertResponse done; output written to', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });
