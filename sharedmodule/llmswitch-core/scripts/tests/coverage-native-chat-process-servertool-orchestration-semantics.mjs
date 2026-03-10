#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-chat-process-servertool-orchestration-semantics.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-native-chat-servertool-sem-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  await withTempNativeModule(
    `
exports.planChatWebSearchOperationsJson = () => JSON.stringify({ shouldInject: true, selectedEngineIndexes: [1, 3] });
exports.planChatClockOperationsJson = () => JSON.stringify({ shouldInject: true });
exports.planContinueExecutionOperationsJson = () => JSON.stringify({ shouldInject: false });
exports.detectProviderResponseShapeJson = () => JSON.stringify('openai-responses');
exports.buildReviewOperationsJson = () => JSON.stringify([
  { op: 'set_request_metadata_fields', fields: { reviewToolEnabled: true } },
  { op: 'append_tool_if_missing', toolName: 'review', tool: { type: 'function' } }
]);
exports.buildContinueExecutionOperationsJson = (shouldInject) => JSON.stringify(
  shouldInject
    ? [
        { op: 'set_request_metadata_fields', fields: { continueExecutionEnabled: true } },
        { op: 'append_tool_if_missing', toolName: 'continue_execution', tool: { type: 'function' } }
      ]
    : []
);
exports.isStopMessageStateActiveJson = () => JSON.stringify(true);
exports.resolveHasActiveStopMessageForContinueExecutionJson = () => JSON.stringify(true);
exports.resolveStopMessageSessionScopeJson = () => JSON.stringify('session:sess_123');
exports.injectContinueExecutionDirectiveJson = (messagesJson, marker, targetText) => {
  const messages = JSON.parse(messagesJson);
  return JSON.stringify({
    changed: true,
    messages: [...messages, { role: 'user', content: marker + '\\\\n' + targetText }]
  });
};
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', undefined);
      const mod = await importFresh('native-chat-process-servertool-semantics');

      const webPlan = mod.planChatWebSearchOperationsWithNative(
        { messages: [], semantics: {} },
        { serverToolFollowup: false },
        () => ({ shouldInject: false, selectedEngineIndexes: [] })
      );
      assert.equal(webPlan.shouldInject, true);
      assert.deepEqual(webPlan.selectedEngineIndexes, [1, 3]);

      const clockPlan = mod.planChatClockOperationsWithNative(
        { serverToolFollowup: false, clock: { enabled: true } },
        { shouldInject: false }
      );
      assert.equal(clockPlan.shouldInject, true);

      const continuePlan = mod.planContinueExecutionOperationsWithNative(
        { serverToolFollowup: false },
        false,
        { shouldInject: true }
      );
      assert.equal(continuePlan.shouldInject, false);

      const responseShape = mod.detectProviderResponseShapeWithNative(
        { object: 'response', output: [] },
        'unknown'
      );
      assert.equal(responseShape, 'openai-responses');

      const reviewOps = mod.buildReviewOperationsWithNative(
        { __rt: { serverToolFollowup: false } },
        () => []
      );
      assert.equal(Array.isArray(reviewOps), true);
      assert.equal(reviewOps.length, 2);
      assert.equal(reviewOps[0].op, 'set_request_metadata_fields');
      assert.equal(reviewOps[1].toolName, 'review');

      const continueOps = mod.buildContinueExecutionOperationsWithNative(
        true,
        () => []
      );
      assert.equal(Array.isArray(continueOps), true);
      assert.equal(continueOps.length, 2);
      assert.equal(continueOps[0].op, 'set_request_metadata_fields');
      assert.equal(continueOps[1].toolName, 'continue_execution');

      const stopMessageActive = mod.isStopMessageStateActiveWithNative(
        { stopMessageText: '继续执行', stopMessageMaxRepeats: 10, stopMessageStageMode: 'on' },
        false
      );
      assert.equal(stopMessageActive, true);

      const stopMessageScope = mod.resolveStopMessageSessionScopeWithNative(
        { sessionId: 'sess_123' },
        undefined
      );
      assert.equal(stopMessageScope, 'session:sess_123');

      const hasActiveStopMessage = mod.resolveHasActiveStopMessageForContinueExecutionWithNative(
        { stopMessageText: '继续执行', stopMessageMaxRepeats: 10, stopMessageStageMode: 'on' },
        null,
        false
      );
      assert.equal(hasActiveStopMessage, true);

      const injected = mod.injectContinueExecutionDirectiveWithNative(
        [{ role: 'user', content: 'start' }],
        '[routecodex:continue_execution_injection]',
        '继续执行',
        () => ({ changed: false, messages: [] })
      );
      assert.equal(injected.changed, true);
      assert.equal(Array.isArray(injected.messages), true);
      assert.equal(injected.messages.length, 2);
      assert.equal(injected.messages[1].role, 'user');
    }
  );

  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }
  if (prevRccNativePath === undefined) {
    delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.RCC_LLMS_ROUTER_NATIVE_PATH = prevRccNativePath;
  }

  console.log('✅ coverage-native-chat-process-servertool-orchestration-semantics passed');
}

main().catch((error) => {
  console.error('❌ coverage-native-chat-process-servertool-orchestration-semantics failed:', error);
  process.exit(1);
});
