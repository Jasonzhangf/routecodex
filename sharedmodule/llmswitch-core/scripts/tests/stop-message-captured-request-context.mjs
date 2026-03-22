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

function createVirtualRouterBootstrapInput() {
  return {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: { key1: { value: 'dummy' } }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:single',
            priority: 100,
            mode: 'priority',
            targets: ['tab.key1.gpt-4o-mini']
          }
        ]
      },
      classifier: {}
    }
  };
}

async function main() {
  let tmpSessionDir;
  const originalAutoEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
  const originalAutoIflow = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
  const { HubPipeline, __unsafeBuildAdapterContextForTest } = await importModule('conversion/hub/pipeline/hub-pipeline.js');
  const { bootstrapVirtualRouterConfig } = await importModule('router/virtual-router/bootstrap.js');
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');
  const { saveRoutingInstructionStateSync } = await importModule('router/virtual-router/sticky-session-store.js');

  tmpSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stopmsg-captured-'));
  process.env.ROUTECODEX_SESSION_DIR = tmpSessionDir;
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = '0';
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '0';

  const { config: virtualRouter } = bootstrapVirtualRouterConfig(createVirtualRouterBootstrapInput());
  const hubPipeline = new HubPipeline({ virtualRouter });

  const capturedChatRequest = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: '请继续执行，不要中断。' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
            additionalProperties: false
          }
        }
      }
    ]
  };

  assert.equal(typeof __unsafeBuildAdapterContextForTest, 'function', '__unsafeBuildAdapterContextForTest should be callable');

  const adapterContext = __unsafeBuildAdapterContextForTest({
    id: 'req_stopmsg_context_capture',
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: {},
    metadata: {
      sessionId: 'stopmsg-captured-chat-seed',
      tmuxSessionId: 'tmux_stopmsg_captured_chat_seed',
      capturedChatRequest
    },
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    stream: false
  });

  saveRoutingInstructionStateSync('tmux:tmux_stopmsg_captured_chat_seed', {
    forcedTarget: undefined,
    stickyTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageText: '继续执行',
    stopMessageMaxRepeats: 3,
    stopMessageUsed: 0,
    stopMessageSource: 'explicit',
    stopMessageStageMode: 'on'
  });

  assert.ok(adapterContext && typeof adapterContext === 'object', 'adapterContext should be created');
  assert.ok(adapterContext.capturedChatRequest, 'capturedChatRequest should be preserved in adapterContext');
  assert.deepEqual(adapterContext.capturedChatRequest, capturedChatRequest, 'capturedChatRequest must be lossless');

  let dispatchArgs = null;
  let reenterCalled = false;
  const result = await runServerToolOrchestration({
    chat: {
      id: 'chatcmpl_stop',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: '阶段完成。' }
        }
      ]
    },
    adapterContext,
    requestId: 'req_stopmsg_context_capture',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    clientInjectDispatch: async (args) => {
      dispatchArgs = args;
      return { ok: true };
    },
    reenterPipeline: async (args) => {
      reenterCalled = true;
      return {
        body: {
          id: 'chatcmpl_followup',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' }
            }
          ]
        }
      };
    }
  });

  assert.equal(result.executed, true, 'stopMessage should execute followup flow');
  assert.equal(result.flowId, 'stop_message_flow', 'expected stop_message_flow');
  assert.equal(reenterCalled, false, 'stop_message_flow clientInjectOnly should not call reenter');
  assert.ok(dispatchArgs && typeof dispatchArgs === 'object', 'client inject dispatch args should be generated');
  const metadata = dispatchArgs.metadata && typeof dispatchArgs.metadata === 'object' ? dispatchArgs.metadata : {};
  assert.equal(metadata.clientInjectOnly, true, 'stopMessage should use clientInjectOnly followup');
  const injectText = typeof metadata.clientInjectText === 'string' ? metadata.clientInjectText : '';
  assert.ok(
    injectText.includes('继续执行'),
    'stopMessage followup text should be injected'
  );
  const followupBody = dispatchArgs.body && typeof dispatchArgs.body === 'object' ? dispatchArgs.body : {};
  assert.equal(Array.isArray(followupBody.messages), false, 'clientInjectOnly followup should not carry reenter message history');

  hubPipeline.dispose();
  console.log('[matrix:stop-message-captured-request-context] ok');
  if (tmpSessionDir) {
    try {
      await fs.rm(tmpSessionDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup races from async state writes
    }
  }
  if (typeof originalAutoEnabled === 'string') {
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = originalAutoEnabled;
  } else {
    delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
  }
  if (typeof originalAutoIflow === 'string') {
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = originalAutoIflow;
  } else {
    delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
  }
}

main().catch((error) => {
  console.error('[matrix:stop-message-captured-request-context] failed', error);
  process.exit(1);
});
