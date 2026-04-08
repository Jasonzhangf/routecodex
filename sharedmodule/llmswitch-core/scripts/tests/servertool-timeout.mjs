#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

async function main() {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');

  process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS = '5000';
  process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS = '50';

  const sessionId = `servertool-timeout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestId = `req_${Date.now()}`;

  const adapterContext = {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
    providerKey: 'antigravity.test.timeout',
    sessionId,
    capturedChatRequest: {
      model: 'gpt-5.2-codex',
      messages: [{ role: 'user', content: 'hi' }]
    }
  };

  const chat = {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '', reasoning: '我需要继续执行下一步。' }
      }
    ]
  };

  const never = new Promise(() => {});
  const start = Date.now();
  try {
    await runServerToolOrchestration({
      chat,
      adapterContext,
      requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => never
    });
    console.error('❌ expected servertool followup timeout, but orchestration completed');
    process.exit(1);
  } catch (error) {
    const elapsed = Date.now() - start;
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code !== 'SERVERTOOL_TIMEOUT') {
      console.error('❌ expected code=SERVERTOOL_TIMEOUT, got:', code);
      console.error(error);
      process.exit(1);
    }
    if (elapsed > 1500) {
      console.error('❌ timeout took too long:', elapsed, 'ms');
      process.exit(1);
    }
    console.log('✅ servertool followup timeout surfaced:', { code, elapsedMs: elapsed });
  }
}

main().catch((err) => {
  console.error('servertool-timeout test crashed:', err);
  process.exit(1);
});
