#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function main() {
  const runtimeUtils = await import(
    path.join(
      projectRoot,
      'dist',
      'servertool',
      'handlers',
      'stop-message-auto',
      'runtime-utils.js',
    )
  );

  const captured = runtimeUtils.getCapturedRequest({
    capturedChatRequest: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    },
    __rt: {
      capturedChatRequest: {
        model: 'wrong-runtime-copy',
      },
    },
    originalRequest: {
      model: 'wrong-original-copy',
    },
  });

  assert.deepEqual(captured, {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  const noFallback = runtimeUtils.getCapturedRequest({
    __rt: {
      capturedChatRequest: {
        model: 'runtime-copy',
      },
    },
    originalRequest: {
      model: 'original-copy',
    },
  });

  assert.equal(
    noFallback,
    null,
    'capturedChatRequest should not fall back to runtime or originalRequest copies',
  );

  const sessionScopeFromOriginalOnly = runtimeUtils.resolveStopMessageSessionScope({
    originalRequest: {
      metadata: {
        tmuxSessionId: 'wrong-original-tmux',
      },
    },
  });

  assert.equal(
    sessionScopeFromOriginalOnly,
    undefined,
    'stopMessage session scope should not fall back to originalRequest metadata copies',
  );

  const workdirFromOriginalOnly = runtimeUtils.resolveBdWorkingDirectoryForRecord(
    {
      originalRequest: {
        metadata: {
          workdir: '/tmp/wrong-original-workdir',
        },
      },
    },
    {},
  );

  assert.equal(
    workdirFromOriginalOnly,
    undefined,
    'bd workdir should not fall back to originalRequest metadata copies',
  );

  console.log('✅ servertool capturedChatRequest single-source regression passed');
}

main().catch((error) => {
  console.error('❌ servertool capturedChatRequest single-source regression failed:', error);
  process.exit(1);
});
