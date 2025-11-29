#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { promises as fs } from 'node:fs';

const DEFAULT_PORT = 5560;
const DEFAULT_TIMEOUT_MS = 45000;
const baseDir = process.cwd();
const port = Number(process.env.ROUTECODEX_INSTALL_HEALTH_PORT || DEFAULT_PORT);
const timeoutMs = Number(process.env.ROUTECODEX_INSTALL_HEALTH_TIMEOUT || DEFAULT_TIMEOUT_MS);
const host = process.env.ROUTECODEX_INSTALL_HEALTH_HOST || '127.0.0.1';
const healthUrl = process.env.ROUTECODEX_INSTALL_HEALTH_URL || `http://${host}:${port}/health`;
const chatUrl = process.env.ROUTECODEX_INSTALL_CHAT_URL || `http://${host}:${port}/v1/chat/completions`;

const env = {
  ...process.env,
  ROUTECODEX_PORT: String(port),
  RCC_PORT: String(port),
  ROUTECODEX_BASEDIR: baseDir,
  RCC_BASEDIR: baseDir
};

const server = spawn(process.execPath, ['dist/index.js'], {
  cwd: baseDir,
  env,
  stdio: ['ignore', 'inherit', 'inherit']
});

async function waitForHealth() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before health check completed (exit ${server.exitCode})`);
    }
    try {
      const res = await fetch(healthUrl, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        console.log(`✅ Health check passed (${healthUrl})`, body?.status || 'ok');
        return;
      }
    } catch (error) {
      // swallow and retry
    }
    await delay(1000);
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms (URL: ${healthUrl})`);
}

async function resolveTestModel() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.routecodex', 'config', 'generated', `virtual-router-config.${port}.generated.json`),
    path.join(home, '.routecodex', 'config', 'generated', 'virtual-router-config.generated.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(raw);
      const routing = json?.virtualrouter?.routing;
      if (routing && typeof routing === 'object') {
        for (const key of Object.keys(routing)) {
          const routes = routing[key];
          if (Array.isArray(routes) && routes.length) {
            const entry = String(routes[0]);
            const [, modelId] = entry.split('.');
            if (modelId) return modelId;
          }
        }
      }
    } catch {
      // fallthrough
    }
  }
  return 'glm-4.6';
}

async function verifyToolInvocation() {
  const model = await resolveTestModel();
  const payload = {
    model,
    stream: false,
    temperature: 0,
    max_tokens: 64,
    tool_choice: {
      type: 'function',
      function: { name: 'shell' }
    },
    tools: [
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'Execute a shell command on the server and return stdout',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Shell command to execute'
              }
            },
            required: ['command']
          }
        }
      }
    ],
    messages: [
      {
        role: 'system',
        content: 'You **must** call the shell tool to list the current working directory. Do not answer directly.'
      },
      {
        role: 'user',
        content: 'List the current directory contents using the shell tool and then stop.'
      }
    ]
  };

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tool verification request failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error('Tool verification response did not include tool_calls');
  }
  const shellCall = toolCalls.find((call) => call?.function?.name === 'shell');
  if (!shellCall) {
    throw new Error('Tool verification response missing shell tool call');
  }
  let args = shellCall.function?.arguments;
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args ?? {});
    } catch {
      args = String(args ?? '');
    }
  }
  let parsedCommand = '';
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
      parsedCommand = parsed.command;
    }
  } catch {
    // fall back to raw string
  }
  if (!parsedCommand) {
    parsedCommand = args;
  }
  if (typeof parsedCommand !== 'string' || !/\bls\b/.test(parsedCommand)) {
    throw new Error(`Shell tool arguments missing ls command: ${parsedCommand}`);
  }
  console.log('✅ Tool invocation verified via /v1/chat/completions');
}

(async () => {
  try {
    await waitForHealth();
    await verifyToolInvocation();
  } catch (error) {
    server.kill('SIGINT');
    await once(server, 'exit').catch(() => {});
    console.error('❌ Health check failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
  server.kill('SIGINT');
  await once(server, 'exit').catch(() => {});
  console.log('🛑 Temporary server stopped after health check.');
  process.exit(0);
})();
