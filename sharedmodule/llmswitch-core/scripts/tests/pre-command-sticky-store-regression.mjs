#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-precommand-state-'));
  const userDir = path.join(tmpRoot, 'user');
  const precommandDir = path.join(userDir, 'precommand');
  const sessionDir = path.join(tmpRoot, 'sessions');
  await fs.mkdir(precommandDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  process.env.ROUTECODEX_USER_DIR = userDir;
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  const scriptPath = path.join(precommandDir, 'rewrite-exec-command.sh');
  await fs.writeFile(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      'cat >/dev/null',
      'printf \'{"cmd":"echo patched-from-precommand"}\\n\''
    ].join('\n'),
    { mode: 0o755 }
  );

  const { saveRoutingInstructionStateSync } = await importModule('router/virtual-router/sticky-session-store.js');
  const { runServerSideToolEngine } = await importModule('servertool/server-side-tools.js');

  saveRoutingInstructionStateSync('session:precommand-session', {
    forcedTarget: undefined,
    stickyTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    preCommandScriptPath: scriptPath,
    preCommandSource: 'explicit',
    preCommandUpdatedAt: Date.now()
  });

  const chat = {
    id: 'chatcmpl_precommand',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_exec_1',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'echo original-command' })
              }
            }
          ]
        }
      }
    ]
  };

  const result = await runServerSideToolEngine({
    chatResponse: chat,
    adapterContext: {
      requestId: 'req_precommand_state',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'precommand-session'
    },
    requestId: 'req_precommand_state',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    disableToolCallHandlers: false
  });

  const args =
    result.finalChatResponse?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  assert.equal(
    args,
    '{"cmd":"echo patched-from-precommand"}',
    'pre-command hook should load rule from sticky session state and rewrite tool args'
  );

  console.log('✅ pre-command sticky-store regression passed');
}

main().catch((error) => {
  console.error('❌ pre-command sticky-store regression failed:', error);
  process.exit(1);
});
