#!/usr/bin/env node
/**
 * Anthropic /v1/messages 四配置对比脚本
 *
 * 用途：
 *   - 针对同一个 /v1/messages 请求负载，分别打到 4 个 RouteCodex 实例：
 *       1) 全 codec（Chat ↔ Anth）
 *       2) 全 passthrough
 *       3) 请求 codec，响应 passthrough
 *       4) 请求 passthrough，响应 codec
 *   - 帮你在真实流水线下快速对比 4 条通路的行为差异（是否报错、是否秒停、响应形状）。
 *
 * 使用方式：
 *   - 本脚本会自己按顺序启动/停止 4 次 RouteCodex server：
 *       --codec-config           全 codec 的 glm-anthropic config（例如 config.json）
 *       --passthrough-config     全 passthrough 的 glm-anthropic config
 *       --req-chat-resp-pass-config   请求 codec / 响应 passthrough
 *       --req-pass-resp-chat-config   请求 passthrough / 响应 codec
 *   - 每次启动一个 server，用同一 payload 打一次 /v1/messages，然后立刻关掉该 server。
 *
 * 示例：
 *
 *   node scripts/anthropic-four-config-e2e.mjs \\
 *     --codec-config ~/.routecodex/provider/glm-anthropic/config.json \\
 *     --passthrough-config ~/.routecodex/provider/glm-anthropic/config.passthrough.json \\
 *     --req-chat-resp-pass-config ~/.routecodex/provider/glm-anthropic/config.req-chat_resp-pass.json \\
 *     --req-pass-resp-chat-config ~/.routecodex/provider/glm-anthropic/config.req-pass_resp-chat.json \\
 *     --payload-file ~/.routecodex/codex-samples/anthropic-messages/req_XXXX_server-pre-process.json
 *
 * 说明：
 *   - payload-file 应该是一份 Anthropic /v1/messages 形状的 JSON（带 model/system/messages/tools）。
 *   - 脚本不会改 payload，只是原样 POST 到 4 个不同 baseURL 的 /v1/messages。
 *   - 差异的细节（provider-request/provider-error/finalize-post）仍然通过 codex-samples 快照来看。
 */

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      args[key] = val;
    }
  }
  return args;
}

function loadJson(file) {
  const p = file.replace(/^~/, os.homedir());
  const txt = fs.readFileSync(p, 'utf8');
  return JSON.parse(txt);
}

function extractPayloadFromServerPre(obj) {
  // 兼容形状：
  //  - { data: { originalData: <anthReq> } }
  //  - 或直接就是 Anth request
  if (obj && typeof obj === 'object') {
    const data = obj.data && typeof obj.data === 'object' ? obj.data : null;
    if (data && data.originalData && typeof data.originalData === 'object') {
      return data.originalData;
    }
  }
  return obj;
}

async function postMessages(baseUrl, payload) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const body = JSON.stringify(payload);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body
    });
    const ms = Date.now() - start;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 可能是 SSE 或非 JSON 错误
    }
    return {
      ok: res.ok,
      status: res.status,
      ms,
      rawText: text,
      json
    };
  } catch (err) {
    const ms = Date.now() - start;
    return {
      ok: false,
      status: 0,
      ms,
      error: err?.message || String(err)
    };
  }
}

function summarizeResult(label, result) {
  const summary = { label };
  if (result.ok) {
    summary.status = result.status;
    summary.ms = result.ms;
    if (result.json && typeof result.json === 'object') {
      const j = result.json;
      summary.type = j.type || j.object || 'unknown';
      summary.stop_reason = j.stop_reason || j.stopReason || (j.error && j.error.type) || null;
      // Anthropic message 常见字段
      if (Array.isArray(j.content)) {
        summary.blockTypes = j.content.map(b => String(b.type || ''));
      }
    } else {
      summary.type = 'non-json';
    }
  } else {
    summary.status = result.status;
    summary.ms = result.ms;
    summary.error = result.error || (result.rawText || '').slice(0, 200);
  }
  return summary;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs = 10000) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const start = Date.now();
  // 简单轮询：发空 payload，收到任何 HTTP 响应就认为 server 已经起来
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'dummy', messages: [] })
      });
      // 无论 4xx/5xx，都说明端口和路由已经 ready 了
      if (res.status > 0) return;
    } catch {
      // 端口还没起来，继续等
    }
    await delay(300);
  }
  throw new Error(`等待 server 启动超时: ${baseUrl}`);
}

async function runOnce(label, configPath, payload) {
  // RouteCodex dev 模式默认使用 5555 端口（忽略配置中的 httpserver.port）
  const baseUrl = 'http://127.0.0.1:5555';
  console.log(`\n=== [${label}] 启动 server: ${configPath} @ ${baseUrl} ===`);

  const child = spawn('routecodex', ['start', '--config', configPath], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let started = false;
  child.stdout.on('data', (chunk) => {
    const s = chunk.toString();
    process.stdout.write(`[server-${label}] ${s}`);
    if (s.includes('Routes setup completed')) {
      started = true;
    }
  });
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    process.stderr.write(`[server-${label}-err] ${s}`);
  });

  try {
    if (!started) {
      await waitForServer(baseUrl, 15000);
    }
  } catch (e) {
    console.error(`等待 [${label}] server 启动失败:`, e.message || String(e));
  }

  const res = await postMessages(baseUrl, payload);
  const summary = summarizeResult(label, res);
  console.log(`[${label}] 摘要:`, summary);

  // 关停 server
  try {
    child.kill('SIGINT');
  } catch {}
  // 给一点时间退出
  await delay(1000);

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);

  const codecCfg = args['codec-config'] || '';
  const passthroughCfg = args['passthrough-config'] || '';
  const reqChatRespPassCfg = args['req-chat-resp-pass-config'] || '';
  const reqPassRespChatCfg = args['req-pass-resp-chat-config'] || '';
  const payloadFile = args['payload-file'] || '';

  if (!payloadFile) {
    console.error('缺少 --payload-file 参数（Anthropic /v1/messages 请求 JSON）。');
    process.exit(2);
  }

  const payloadRaw = loadJson(payloadFile);
  const payload = extractPayloadFromServerPre(payloadRaw);

  const targets = [
    { label: 'codec', cfg: codecCfg },
    { label: 'passthrough', cfg: passthroughCfg },
    { label: 'req-chat_resp-pass', cfg: reqChatRespPassCfg },
    { label: 'req-pass_resp-chat', cfg: reqPassRespChatCfg }
  ].filter(t => t.cfg);

  if (!targets.length) {
    console.error('至少需要指定一个配置，例如 --codec-config ~/.routecodex/provider/glm-anthropic/config.json');
    process.exit(2);
  }

  console.log('请求 payload 摘要:', {
    model: payload.model,
    hasSystem: Array.isArray(payload.system) && payload.system.length > 0,
    msgRoles: Array.isArray(payload.messages)
      ? payload.messages.map(m => String(m.role || ''))
      : [],
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0
  });

  const results = [];
  for (const t of targets) {
    const summary = await runOnce(t.label, t.cfg, payload);
    results.push(summary);
  }

  console.log('\n=== 汇总 ===');
  for (const r of results) {
    console.log(r);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main().catch(err => {
    console.error('anthropic-four-config-e2e 出错:', err);
    process.exit(1);
  });
}
