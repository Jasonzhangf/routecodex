#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';
import { parseRoutingInstructions } from '../../dist/router/virtual-router/routing-instructions.js';

function createEngine() {
  const engine = new VirtualRouterEngine();
  engine.initialize({
    routing: {
      default: [{ id: 'default', targets: ['glm.1.glm-4.7'], priority: 10 }]
    },
    providers: {
      'glm.1.glm-4.7': {
        providerKey: 'glm.1.glm-4.7',
        providerType: 'openai',
        endpoint: 'http://localhost',
        auth: { type: 'apiKey', value: 'dummy' },
        outboundProfile: 'openai',
        modelId: 'glm-4.7'
      }
    },
    classifier: {}
  });
  return engine;
}

function route(engine, sessionId, requestId, content) {
  const tmuxSessionId = `tmux-${sessionId}`;
  return engine.route(
    {
      model: 'glm-4.7',
      messages: [{ role: 'user', content }],
      parameters: {},
      metadata: { originalEndpoint: '/v1/chat/completions', sessionId, tmuxSessionId }
    },
    {
      requestId,
      sessionId,
      clientTmuxSessionId: tmuxSessionId,
      tmuxSessionId,
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    }
  );
}

async function exists(filepath) {
  try {
    await fs.stat(filepath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const originalHome = process.env.HOME;
  const originalUserDir = process.env.ROUTECODEX_USER_DIR;
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-msg-clear-'));
  const userDir = path.join(tmpRoot, 'user');
  const sessionDir = path.join(userDir, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  process.env.HOME = tmpRoot;
  process.env.ROUTECODEX_USER_DIR = userDir;
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  try {
    const parsed = parseRoutingInstructions([
      {
        role: 'user',
        content: '<**stopMessage:"继续执行",3**> keep going <**clear**> done'
      }
    ]);
    assert.equal(parsed.length, 1, 'global clear should dominate in the same turn');
    assert.equal(parsed[0]?.type, 'clear');
    const parsedCaseInsensitiveClear = parseRoutingInstructions([
      { role: 'user', content: '<**CLEAR**>' }
    ]);
    assert.equal(parsedCaseInsensitiveClear.length, 1, 'clear should be case-insensitive');
    assert.equal(parsedCaseInsensitiveClear[0]?.type, 'clear');

    const engine = createEngine();
    const sessionId = `clear-hard-reset-${Date.now()}`;
    const tmuxSessionId = `tmux-${sessionId}`;
    const sessionStateFile = path.join(sessionDir, `tmux-${tmuxSessionId}.json`);

    route(engine, sessionId, 'req-set', '<**stopMessage:"继续执行",3**> 设置 stopMessage');
    const stopBeforeClear = engine.getStopMessageState({
      requestId: 'snap-before',
      sessionId,
      clientTmuxSessionId: tmuxSessionId,
      tmuxSessionId,
      entryEndpoint: '/v1/chat/completions'
    });
    assert.ok(stopBeforeClear, 'stopMessage state should exist before clear');
    assert.equal(await exists(sessionStateFile), true, 'session persistence should exist before clear');

    route(engine, sessionId, 'req-clear', '<**clear**> 清除全部状态');
    const stopAfterClear = engine.getStopMessageState({
      requestId: 'snap-after',
      sessionId,
      clientTmuxSessionId: tmuxSessionId,
      tmuxSessionId,
      entryEndpoint: '/v1/chat/completions'
    });
    assert.equal(stopAfterClear, null, 'clear should remove stopMessage armed state');
    assert.equal(await exists(sessionStateFile), false, 'clear should delete persisted session markers');

    route(engine, sessionId, 'req-post-clear', '继续普通对话，不带 marker');
    const stopAfterReplay = engine.getStopMessageState({
      requestId: 'snap-replay',
      sessionId,
      clientTmuxSessionId: tmuxSessionId,
      tmuxSessionId,
      entryEndpoint: '/v1/chat/completions'
    });
    assert.equal(stopAfterReplay, null, 'historical clear should continue to keep stopMessage cleared');
    assert.equal(await exists(sessionStateFile), false, 'historical clear should not recreate persisted markers');

    console.log('✅ stop-message global clear hard-reset checks passed');
  } finally {
    if (typeof originalHome === 'string') process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (typeof originalUserDir === 'string') process.env.ROUTECODEX_USER_DIR = originalUserDir;
    else delete process.env.ROUTECODEX_USER_DIR;
    if (typeof originalSessionDir === 'string') process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    else delete process.env.ROUTECODEX_SESSION_DIR;
  }
}

main().catch((error) => {
  console.error('❌ stop-message global clear hard-reset failed:', error);
  process.exit(1);
});
