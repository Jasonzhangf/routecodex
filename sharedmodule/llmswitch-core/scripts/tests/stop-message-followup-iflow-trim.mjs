#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

function buildLongMessages(total = 120) {
  const longToolText = 'tool-output '.repeat(260);
  const messages = [];
  for (let index = 0; index < total; index += 1) {
    if (index % 4 === 0) {
      messages.push({ role: 'assistant', content: `assistant-${index}` });
      continue;
    }
    if (index % 4 === 1) {
      messages.push({ role: 'user', content: `user-${index}` });
      continue;
    }
    if (index % 4 === 2) {
      messages.push({
        role: 'assistant',
        tool_calls: [
          {
            id: `tc_${index}`,
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
          }
        ]
      });
      continue;
    }
    messages.push({ role: 'tool', tool_call_id: `tc_${index - 1}`, content: `${longToolText} #${index}` });
  }
  return messages;
}

function createAdapterContext(params) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `iflow-stop-shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmuxSessionId = `tmux_${sessionId}`;
  const capturedMessages = [{ role: 'system', content: 'sys' }, ...buildLongMessages(params.historySize ?? 120)];

  const context = {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
    sessionId,
    clientTmuxSessionId: tmuxSessionId,
    tmuxSessionId,
    __rt: {
      stopMessageState: {
        stopMessageText: '继续执行',
        stopMessageMaxRepeats: 3,
        stopMessageUsed: 0,
        stopMessageSource: 'explicit'
      }
    },
    capturedChatRequest: {
      model: 'kimi-k2.5',
      messages: capturedMessages,
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        }
      ]
    }
  };

  if (params.includeProviderKey !== false) {
    context.providerKey = 'iflow.2-173.kimi-k2.5';
  }
  return context;
}

function countRole(messages, roleName) {
  return (Array.isArray(messages) ? messages : []).filter((msg) => {
    const role = typeof msg?.role === 'string' ? msg.role.trim().toLowerCase() : '';
    return role === roleName;
  }).length;
}

async function runCase({ toolContentLimit, includeProviderKey, historySize }) {
  if (typeof toolContentLimit === 'number') {
    process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS = String(toolContentLimit);
  } else {
    delete process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS;
  }

  const { runServerToolOrchestration } = await importModule('servertool/engine.js');

  const base = {
    id: 'chatcmpl_stop',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '先执行' }
      }
    ]
  };

  const adapterContext = createAdapterContext({ includeProviderKey, historySize });

  let dispatchArgs = null;
  let reenterCalled = false;
  const result = await runServerToolOrchestration({
    chat: base,
    adapterContext,
    requestId: adapterContext.requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
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

  assert.equal(result.executed, true, 'stop_message_flow should execute');
  assert.equal(result.flowId, 'stop_message_flow', 'expected stop_message_flow');
  assert.equal(reenterCalled, false, 'stop_message_flow clientInjectOnly should not use reenter');
  assert.ok(dispatchArgs && typeof dispatchArgs === 'object', 'client inject dispatch args should be captured');

  const metadata = dispatchArgs.metadata && typeof dispatchArgs.metadata === 'object' ? dispatchArgs.metadata : {};
  assert.equal(metadata.clientInjectOnly, true, 'stop_message should run as clientInjectOnly');
  const injectText = typeof metadata.clientInjectText === 'string' ? metadata.clientInjectText : '';
  assert.ok(
    injectText.includes('继续执行'),
    `stop message inject text should include base directive, got: ${injectText}`
  );
  const followupBody = dispatchArgs.body && typeof dispatchArgs.body === 'object' ? dispatchArgs.body : {};
  const followupMessages = Array.isArray(followupBody.messages) ? followupBody.messages : [];
  assert.equal(followupMessages.length, 0, 'clientInjectOnly followup should not carry reenter message history');

  return {
    injectTextLength: injectText.length
  };
}

async function main() {
  const originalAutoEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
  const originalAutoIflow = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = '0';
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '0';
  try {
    const explicitLimitCase = await runCase({ toolContentLimit: 200, includeProviderKey: true, historySize: 120 });
    assert.ok(explicitLimitCase.injectTextLength > 0, 'explicit case should provide client injection text');

    // Regression: providerKey missing should still compact by model fallback (kimi-k2.5).
    const fallbackCase = await runCase({ toolContentLimit: undefined, includeProviderKey: false, historySize: 120 });
    assert.ok(fallbackCase.injectTextLength > 0, 'fallback case should provide client injection text');

    console.log('[matrix:stop-message-followup-iflow-trim] ok', {
      explicitLimit: explicitLimitCase,
      fallbackLimit: fallbackCase
    });
  } finally {
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
}

main().catch((error) => {
  console.error('[matrix:stop-message-followup-iflow-trim] failed', error);
  process.exit(1);
});
