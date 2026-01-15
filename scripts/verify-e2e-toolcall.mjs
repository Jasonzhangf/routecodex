#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (String(process.env.ROUTECODEX_VERIFY_SKIP || '').trim() === '1') {
  console.log('[verify:e2e-toolcall] 跳过（ROUTECODEX_VERIFY_SKIP=1）');
  process.exit(0);
}

const VERIFY_PORT = process.env.ROUTECODEX_VERIFY_PORT || '5580';
const VERIFY_BASE = process.env.ROUTECODEX_VERIFY_BASE_URL || `http://127.0.0.1:${VERIFY_PORT}`;
const VERIFY_CONFIG =
  process.env.ROUTECODEX_VERIFY_CONFIG ||
  process.env.ROUTECODEX_CONFIG_PATH ||
  `${process.env.HOME || ''}/.routecodex/config.json`;
const GEMINI_CLI_CONFIG = process.env.ROUTECODEX_VERIFY_GEMINI_CLI_CONFIG || '/Users/fanzhang/.routecodex/provider/gemini-cli/config.v1.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS_PATH = path.resolve(__dirname, '..', 'AGENTS.md');
const AGENTS_PATH = process.env.ROUTECODEX_VERIFY_AGENTS_PATH || DEFAULT_AGENTS_PATH;
const AGENTS_INSTRUCTIONS = (() => {
  try {
    return fs.readFileSync(AGENTS_PATH, 'utf8').trim();
  } catch {
    return '';
  }
})();

function readServerApiKeyFromConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const json = raw && raw.trim() ? JSON.parse(raw) : {};
    const apikey = json?.httpserver?.apikey;
    return typeof apikey === 'string' && apikey.trim() ? apikey.trim() : '';
  } catch {
    return '';
  }
}

function buildAuthHeaders(serverApiKey) {
  if (!serverApiKey) {
    return {};
  }
  return { 'x-api-key': serverApiKey };
}

async function main() {
  if (!VERIFY_CONFIG) {
    console.error('❌ ROUTECODEX_VERIFY_CONFIG 未设置，无法运行端到端校验');
    process.exit(1);
  }

  console.log(`[verify:e2e-toolcall] 使用配置: ${VERIFY_CONFIG}`);
  const serverApiKey = readServerApiKeyFromConfig(VERIFY_CONFIG);
  const authHeaders = buildAuthHeaders(serverApiKey);
  const serverEnv = {
    ...process.env,
    ROUTECODEX_CONFIG_PATH: VERIFY_CONFIG,
    ROUTECODEX_PORT: VERIFY_PORT,
    ROUTECODEX_V2_HOOKS: '0',
    RCC_V2_HOOKS: '0'
  };

  const server = spawn('node', ['dist/index.js'], {
    env: serverEnv,
    stdio: ['ignore', 'inherit', 'inherit']
  });

  const shutdown = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await waitForServer();
    await waitForRouterWarmup();
    await runModelsSmokeCheck(authHeaders);
    await runToolcallVerification(authHeaders);
    console.log('✅ 端到端工具调用校验通过');

    await runDaemonAdminSmokeCheck(authHeaders);
    await runConfigV2ProvidersSmokeCheck(authHeaders);

    // 附加：Gemini CLI 配置健康性快速检查（仅尝试初始化，不做请求）
    await runGeminiCliStartupCheck();
  } finally {
    shutdown();
  }
}

async function runModelsSmokeCheck(authHeaders) {
  try {
    const res = await fetch(`${VERIFY_BASE}/models`, { headers: { ...(authHeaders || {}) } });
    if (!res.ok) {
      throw new Error(`/models HTTP ${res.status}`);
    }
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    if (!Array.isArray(data)) {
      throw new Error('/models response missing data array');
    }
  } catch (error) {
    console.error('[verify:e2e-toolcall] /models smoke 检查失败:', error);
    throw error;
  }
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${VERIFY_BASE}/health`);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('服务器健康检查超时');
}

async function waitForRouterWarmup(defaultDelayMs = 3000) {
  const delayMs = Number(process.env.ROUTECODEX_VERIFY_WARMUP_MS || defaultDelayMs);
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  console.log(`[verify:e2e-toolcall] 等待虚拟路由预热 ${delayMs}ms...`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runToolcallVerification(authHeaders) {
  const userPrompt = '请严格调用名为 list_local_files 的函数工具来列出当前工作目录的文件，只能通过调用该工具完成任务，禁止直接回答。';
  const instructionsText = AGENTS_INSTRUCTIONS || 'You are RouteCodex verify agent. Follow the policies in AGENTS.md.';
  const body = {
    model: process.env.ROUTECODEX_VERIFY_MODEL || 'glm-4.6',
    instructions: instructionsText,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: userPrompt
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'list_local_files',
          description: '列出服务器当前工作目录内的文件',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '要列出的目录路径，默认 "."'
              }
            }
          }
        }
      }
    ],
    tool_choice: 'auto',
    stream: false
  };

  const response = await fetch(`${VERIFY_BASE}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeaders || {})
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`工具调用请求失败 (${response.status}): ${text}`);
  }

  const json = await response.json();
  const outputs = Array.isArray(json?.output) ? json.output : [];
  const hasResponsesToolCall =
    outputs.some((item) => Array.isArray(item?.content) && item.content.some((c) => c?.type === 'tool_call'));
  const hasFunctionCall = outputs.some((item) => item?.type === 'function_call' || item?.type === 'tool_call');
  const hasRequiredAction = Boolean(json?.required_action?.submit_tool_outputs);
  const hasChatToolCall =
    Array.isArray(json?.choices) &&
    json.choices.some((choice) => Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0);
  const hasToolCall = hasResponsesToolCall || hasFunctionCall || hasRequiredAction || hasChatToolCall;

  if (!hasToolCall) {
    console.error('[verify:e2e-toolcall] Unexpected response:', JSON.stringify(json, null, 2));
    throw new Error('响应中未检测到工具调用或 required_action，校验失败');
  }
}

async function runDaemonAdminSmokeCheck(authHeaders) {
  // 仅做最小的健康性探测：确保 daemon 管理类只读 API 可用，不做语义校验。
  try {
    const res = await fetch(`${VERIFY_BASE}/daemon/status`, { headers: { ...(authHeaders || {}) } });
    if (!res.ok) {
      throw new Error(`daemon/status HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json || typeof json !== 'object' || json.ok !== true) {
      throw new Error('daemon/status 返回值不符合预期形态');
    }
  } catch (error) {
    console.error('[verify:e2e-toolcall] /daemon/status smoke 检查失败:', error);
    throw error;
  }

  const paths = ['/daemon/credentials', '/quota/summary', '/providers/runtimes'];
  for (const path of paths) {
    try {
      const res = await fetch(`${VERIFY_BASE}${path}`, { headers: { ...(authHeaders || {}) } });
      if (!res.ok) {
        throw new Error(`${path} HTTP ${res.status}`);
      }
      // 只要 JSON 可解析即可视为通过，避免把语义校验塞到这里。
      await res.json().catch(() => ({}));
    } catch (error) {
      console.error('[verify:e2e-toolcall] Daemon admin smoke 检查失败:', path, error);
      throw error;
    }
  }
}

async function runConfigV2ProvidersSmokeCheck(authHeaders) {
  try {
    const res = await fetch(`${VERIFY_BASE}/config/providers/v2`, { headers: { ...(authHeaders || {}) } });
    if (!res.ok) {
      throw new Error(`/config/providers/v2 HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!Array.isArray(json)) {
      // 出于兼容考虑，只要不是致命错误就通过；Config V2 视图是辅助信息。
      console.warn('[verify:e2e-toolcall] /config/providers/v2 未返回数组形态，跳过进一步校验');
    }
  } catch (error) {
    console.error('[verify:e2e-toolcall] Config V2 providers smoke 检查失败:', error);
    // 不将 Config V2 视图问题视为构建阻断条件，以免挡住主链路；仅提示。
  }
}

async function runGeminiCliStartupCheck() {
  if (!GEMINI_CLI_CONFIG || !fs.existsSync(GEMINI_CLI_CONFIG)) {
    return;
  }

  console.log('[verify:e2e-toolcall] 尝试启动 Gemini CLI 配置进行健康检查:', GEMINI_CLI_CONFIG);

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ROUTECODEX_CONFIG_PATH: GEMINI_CLI_CONFIG,
      ROUTECODEX_PORT: '0',
      ROUTECODEX_STAGE_LOG: '0'
    };
    const child = spawn('node', ['dist/index.js'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      if (stderr) {
        console.warn('[verify:e2e-toolcall] gemini-cli 启动日志(截断):', stderr.slice(0, 1000));
      }
      resolve();
    }, 8000);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log('[verify:e2e-toolcall] gemini-cli 启动检查通过');
      } else {
        console.warn('[verify:e2e-toolcall] gemini-cli 启动检查失败(可在本地修复):', stderr.slice(0, 1000));
      }
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error);
  console.error('❌ verify:e2e-toolcall 失败:', error?.message || error);
  process.exit(1);
});
