#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-continue-execution.js')
).href;
const storeUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'sticky-session-store.js')
).href;

async function importFresh(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function buildStopMessageState(overrides = {}) {
  return {
    stopMessageText: 'halt',
    stopMessageMaxRepeats: 2,
    stopMessageStageMode: 'on',
    ...overrides
  };
}

function buildRoutingState(stopMessageState) {
  return {
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    ...stopMessageState
  };
}

async function main() {
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llms-continue-exec-'));
  const previousUserDir = process.env.ROUTECODEX_USER_DIR;
  process.env.ROUTECODEX_USER_DIR = tmpUserDir;

  try {
    const mod = await importFresh(moduleUrl, 'hub-chat-process-continue-execution');
    const store = await importFresh(storeUrl, 'sticky-session-store');
    const buildContinueExecutionOperations = mod.buildContinueExecutionOperations;
    const injectContinueExecutionDirectiveIntoUserMessage = mod.injectContinueExecutionDirectiveIntoUserMessage;
    const resolveHasActiveStopMessageForContinueExecution = mod.resolveHasActiveStopMessageForContinueExecution;
    const saveRoutingInstructionStateSync = store.saveRoutingInstructionStateSync;
    assert.equal(typeof buildContinueExecutionOperations, 'function');
    assert.equal(typeof injectContinueExecutionDirectiveIntoUserMessage, 'function');
    assert.equal(typeof resolveHasActiveStopMessageForContinueExecution, 'function');
    assert.equal(typeof saveRoutingInstructionStateSync, 'function');

    {
      const out = buildContinueExecutionOperations({
        __rt: { serverToolFollowup: true }
      });
      assert.deepEqual(out, []);
    }

    {
      const out = buildContinueExecutionOperations({
        clientInjectReady: false,
        clientInjectReason: 'tmux_session_missing',
        __rt: {}
      });
      assert.deepEqual(out, []);
    }

    {
      const out = buildContinueExecutionOperations({
        sessionId: 'stop-rt',
        clientInjectReady: true,
        __rt: { stopMessageState: buildStopMessageState() }
      });
      assert.equal(out.length, 2);
      assert.equal(out[1].toolName, 'continue_execution');
    }

    {
      saveRoutingInstructionStateSync('session:stop-persisted', buildRoutingState(buildStopMessageState()));
      const out = buildContinueExecutionOperations({
        sessionId: 'stop-persisted',
        clientInjectReady: true,
        __rt: { stopMessageState: buildStopMessageState({ stopMessageStageMode: 'off' }) }
      });
      assert.deepEqual(out, []);
    }

    {
      const out = buildContinueExecutionOperations({
        clientInjectReady: true,
        __rt: { stopMessageState: buildStopMessageState({ stopMessageStageMode: 'off' }) }
      });
      assert.equal(out.length, 2);
      assert.equal(out[0].op, 'set_request_metadata_fields');
      assert.equal(out[1].op, 'append_tool_if_missing');
      assert.equal(out[1].toolName, 'continue_execution');
    }

    {
      const out = buildContinueExecutionOperations(
        {
          clientInjectReady: true,
          __rt: {}
        },
        {
          hasActiveStopMessage: true,
          precomputedPlan: { shouldInject: false }
        }
      );
      assert.deepEqual(out, []);
    }

    {
      const out = buildContinueExecutionOperations(
        {
          clientInjectReady: true,
          __rt: {}
        },
        {
          hasActiveStopMessage: false,
          precomputedPlan: { shouldInject: true }
        }
      );
      assert.equal(out.length, 2);
      assert.equal(out[1].toolName, 'continue_execution');
    }

    {
      saveRoutingInstructionStateSync('session:persisted-active', buildRoutingState(buildStopMessageState()));
      const out = buildContinueExecutionOperations({
        sessionId: 'persisted-active',
        clientInjectReady: true
      });
      assert.deepEqual(out, []);
    }

    {
      const request = {
        messages: [{ role: 'user', content: 'hello' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        clientInjectReady: false,
        clientInjectReason: 'tmux_session_missing',
        __rt: {}
      });
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'user', content: 'hello' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        clientInjectReady: true,
        __rt: { serverToolFollowup: true }
      });
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'user', content: 'hello' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        clientInjectReady: true,
        __rt: { stopMessageState: buildStopMessageState() }
      });
      assert.notEqual(out, request);
      assert.equal(out.messages[0].content, 'hello\n\n[routecodex:continue_execution_injection]\n继续执行');
    }

    {
      const request = {
        messages: [{ role: 'user', content: 'hello' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        sessionId: 'stop-session',
        clientInjectReady: true,
        __rt: { stopMessageState: buildStopMessageState() }
      });
      assert.notEqual(out, request);
      assert.equal(out.messages[0].content, 'hello\n\n[routecodex:continue_execution_injection]\n继续执行');
    }

    {
      const request = {
        messages: []
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.equal(out, request);
    }

    {
      const request = {};
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'user', content: '[routecodex:continue_execution_injection]\n继续执行' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'user', content: '继续执行' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'assistant', content: 'start' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        sessionId: 'inject-session',
        clientInjectReady: true
      });
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'user', content: 'start' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        sessionId: 'inject-session',
        clientInjectReady: true
      });
      assert.equal(out.messages.length, 1);
      assert.equal(out.messages[0].role, 'user');
      assert.equal(
        out.messages[0].content,
        'start\n\n[routecodex:continue_execution_injection]\n继续执行'
      );
    }

    {
      const request = {
        messages: [{ role: 'user', content: '   ' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.equal(
        out.messages[0].content,
        '[routecodex:continue_execution_injection]\n继续执行'
      );
    }

    {
      const request = {
        messages: [{ role: 'user', content: { type: 'input_text' } }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.equal(
        out.messages[0].content,
        '[routecodex:continue_execution_injection]\n继续执行'
      );
    }

    {
      const request = {
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'array-text' }]
          }
        ]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.deepEqual(out.messages[0].content, [
        {
          type: 'input_text',
          text: 'array-text\n\n[routecodex:continue_execution_injection]\n继续执行'
        }
      ]);
    }

    {
      const request = {
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '   ' }]
          }
        ]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.deepEqual(out.messages[0].content, [
        {
          type: 'input_text',
          text: '[routecodex:continue_execution_injection]\n继续执行'
        }
      ]);
    }

    {
      const request = {
        messages: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {});
      assert.deepEqual(out.messages[0].content, [
        { type: 'input_image', image_url: 'x' },
        { type: 'input_text', text: '[routecodex:continue_execution_injection]\n继续执行' }
      ]);
    }

    {
      saveRoutingInstructionStateSync(
        'conversation:persisted-conversation',
        buildRoutingState(buildStopMessageState())
      );
      const request = {
        messages: [{ role: 'assistant', content: 'start' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        conversationId: 'persisted-conversation',
        clientInjectReady: true
      });
      assert.equal(out, request);
    }

    {
      const request = {
        messages: [{ role: 'assistant', content: 'start' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        clientInjectReady: true,
        __rt: {
          stopMessageState: {
            stopMessageText: 'halt',
            stopMessageMaxRepeats: '0'
          }
        }
      });
      assert.equal(out, request);
    }

    {
      saveRoutingInstructionStateSync('session:persisted-directive', buildRoutingState(buildStopMessageState()));
      const request = {
        messages: [{ role: 'assistant', content: 'start' }]
      };
      const out = injectContinueExecutionDirectiveIntoUserMessage(request, {
        sessionId: 'persisted-directive',
        clientInjectReady: true,
        __rt: {
          stopMessageState: {
            stopMessageText: '',
            stopMessageMaxRepeats: 0,
            stopMessageStageMode: 'off'
          }
        }
      });
      assert.equal(out, request);
    }

    {
      const out = buildContinueExecutionOperations({
        clientInjectReady: true,
        __rt: {
          stopMessageState: {
            stopMessageText: 123,
            stopMessageMaxRepeats: 3
          }
        }
      });
      assert.equal(out.length, 2);
    }

    {
      saveRoutingInstructionStateSync('session:resolve-active', buildRoutingState(buildStopMessageState()));
      const active = resolveHasActiveStopMessageForContinueExecution({
        sessionId: 'resolve-active',
        __rt: { stopMessageState: { stopMessageText: '', stopMessageMaxRepeats: 0, stopMessageStageMode: 'off' } }
      });
      const inactive = resolveHasActiveStopMessageForContinueExecution({
        __rt: { stopMessageState: buildStopMessageState() }
      });
      assert.equal(active, true);
      assert.equal(inactive, false);
    }

    console.log('✅ coverage-hub-chat-process-continue-execution passed');
  } finally {
    if (previousUserDir === undefined) {
      delete process.env.ROUTECODEX_USER_DIR;
    } else {
      process.env.ROUTECODEX_USER_DIR = previousUserDir;
    }
    try {
      fs.rmSync(tmpUserDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-continue-execution failed:', error);
  process.exit(1);
});
