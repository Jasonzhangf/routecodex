import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearPendingServerToolInjection,
  loadPendingServerToolInjection,
  savePendingServerToolInjection
} from '../../sharedmodule/llmswitch-core/src/servertool/pending-session.js';

describe('servertool pending session store', () => {
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const prevPendingMaxAge = process.env.ROUTECODEX_SERVERTOOL_PENDING_MAX_AGE_MS;
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-pending-session-'));
    process.env.ROUTECODEX_SESSION_DIR = tempRoot;
    delete process.env.ROUTECODEX_SERVERTOOL_PENDING_MAX_AGE_MS;
  });

  afterEach(async () => {
    if (prevSessionDir === undefined) delete process.env.ROUTECODEX_SESSION_DIR;
    else process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
    if (prevPendingMaxAge === undefined) delete process.env.ROUTECODEX_SERVERTOOL_PENDING_MAX_AGE_MS;
    else process.env.ROUTECODEX_SERVERTOOL_PENDING_MAX_AGE_MS = prevPendingMaxAge;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('loads fresh pending injection', async () => {
    const sessionId = 'session-fresh';
    await savePendingServerToolInjection(sessionId, {
      createdAtMs: Date.now(),
      afterToolCallIds: ['call-1'],
      messages: [{ role: 'assistant' } as any],
      sourceRequestId: 'req-1'
    });

    const loaded = await loadPendingServerToolInjection(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(sessionId);
    expect(loaded?.afterToolCallIds).toEqual(['call-1']);
  });

  test('drops stale pending injection and removes stale file', async () => {
    const sessionId = 'session-stale';
    process.env.ROUTECODEX_SERVERTOOL_PENDING_MAX_AGE_MS = '1000';
    await savePendingServerToolInjection(sessionId, {
      createdAtMs: Date.now() - 10_000,
      afterToolCallIds: ['call-1'],
      messages: [{ role: 'assistant' } as any],
      sourceRequestId: 'req-old'
    });

    const loaded = await loadPendingServerToolInjection(sessionId);
    expect(loaded).toBeNull();

    const pendingFile = path.join(tempRoot, 'servertool-pending', `${sessionId}.json`);
    await expect(fs.access(pendingFile)).rejects.toBeTruthy();
  });

  test('clear removes pending file', async () => {
    const sessionId = 'session-clear';
    await savePendingServerToolInjection(sessionId, {
      createdAtMs: Date.now(),
      afterToolCallIds: ['call-2'],
      messages: [{ role: 'assistant' } as any]
    });
    await clearPendingServerToolInjection(sessionId);
    const loaded = await loadPendingServerToolInjection(sessionId);
    expect(loaded).toBeNull();
  });
});
