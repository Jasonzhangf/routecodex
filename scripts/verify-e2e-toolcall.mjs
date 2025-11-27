#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

if (String(process.env.ROUTECODEX_VERIFY_SKIP || '').trim() === '1') {
  console.log('[verify:e2e-toolcall] 跳过（ROUTECODEX_VERIFY_SKIP=1）');
  process.exit(0);
}

const VERIFY_PORT = process.env.ROUTECODEX_VERIFY_PORT || '5580';
const VERIFY_BASE = process.env.ROUTECODEX_VERIFY_BASE_URL || `http://127.0.0.1:${VERIFY_PORT}`;
const VERIFY_CONFIG = process.env.ROUTECODEX_VERIFY_CONFIG || '/Users/fanzhang/.routecodex/provider/glm/config.v1.json';

async function main() {
  if (!VERIFY_CONFIG) {
    console.error('❌ ROUTECODEX_VERIFY_CONFIG 未设置，无法运行端到端校验');
    process.exit(1);
  }

  console.log(`[verify:e2e-toolcall] 使用配置: ${VERIFY_CONFIG}`);
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
    await runToolcallVerification();
    console.log('✅ 端到端工具调用校验通过');
  } finally {
    shutdown();
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

async function runToolcallVerification() {
  const body = {
    model: process.env.ROUTECODEX_VERIFY_MODEL || 'glm-4.6',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请严格调用名为 list_local_files 的函数工具来列出当前工作目录的文件，只能通过调用该工具完成任务，禁止直接回答。'
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
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`工具调用请求失败 (${response.status}): ${text}`);
  }

  const json = await response.json();
  const hasResponsesToolCall =
    Array.isArray(json?.output) && json.output.some((item) => Array.isArray(item?.content) && item.content.some((c) => c?.type === 'tool_call'));
  const hasRequiredAction = Boolean(json?.required_action?.submit_tool_outputs);
  const hasChatToolCall =
    Array.isArray(json?.choices) &&
    json.choices.some((choice) => Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0);
  const hasToolCall = hasResponsesToolCall || hasRequiredAction || hasChatToolCall;

  if (!hasToolCall) {
    console.error('[verify:e2e-toolcall] Unexpected response:', JSON.stringify(json, null, 2));
    throw new Error('响应中未检测到工具调用或 required_action，校验失败');
  }
}

main().catch((error) => {
  console.error(error);
  console.error('❌ verify:e2e-toolcall 失败:', error?.message || error);
  process.exit(1);
});
