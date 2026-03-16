import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

describe('codex-samples snapshot bucket uses entry endpoint', () => {
  const prevSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const prevSnapshotDirCompat = process.env.RCC_SNAPSHOT_DIR;
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-snapshot-entry-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    jest.resetModules();
  });

  afterEach(async () => {
    if (prevSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = prevSnapshotDir;
    }
    if (prevSnapshotDirCompat === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = prevSnapshotDirCompat;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  async function loadSnapshotWriterWithBridgeFailure() {
    const mockBridgeModule = () => ({
      writeSnapshotViaHooks: jest.fn(async () => {
        throw new Error('[llmswitch-bridge] writeSnapshotViaHooks not available');
      })
    });
    jest.unstable_mockModule('../../src/modules/llmswitch/bridge.js', mockBridgeModule);
    jest.unstable_mockModule('../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

    const runtimeFlagsModule = await import('../../src/runtime/runtime-flags.ts');
    runtimeFlagsModule.setRuntimeFlag('snapshotsEnabled', true);
    return await import('../../src/providers/core/utils/snapshot-writer.ts');
  }

  test('host provider snapshot buckets by entry endpoint, not upstream url', async () => {
    const { writeProviderSnapshot } = await loadSnapshotWriterWithBridgeFailure();

    const groupRequestId = 'req_snapshot_bucket_messages_1';
    const providerKey = 'iflow.1-186.minimax-m2.5';
    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: groupRequestId,
      clientRequestId: groupRequestId,
      entryEndpoint: '/v1/messages',
      url: 'https://apis.iflow.cn/v1/chat/completions',
      providerKey,
      data: { test: true }
    });

    const messagesDir = path.join(tempDir, 'anthropic-messages', providerKey, groupRequestId);
    const chatDir = path.join(tempDir, 'openai-chat', providerKey, groupRequestId);

    expect(fs.existsSync(messagesDir)).toBe(true);
    expect(fs.existsSync(chatDir)).toBe(false);
  });

  test('fallback snapshot bucket ignores nested endpoint fields and keeps entry bucket', async () => {
    const { writeProviderSnapshot } = await loadSnapshotWriterWithBridgeFailure();

    const groupRequestId = 'req_snapshot_bucket_messages_2';
    const providerKey = 'iflow.2-173.minimax-m2.5';
    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: groupRequestId,
      clientRequestId: groupRequestId,
      entryEndpoint: '/v1/messages',
      providerKey,
      data: {
        endpoint: 'https://apis.iflow.cn/v1/chat/completions',
        meta: {
          context: {
            endpoint: '/v1/chat/completions'
          }
        }
      }
    });

    const messagesDir = path.join(tempDir, 'anthropic-messages', providerKey, groupRequestId);
    const chatDir = path.join(tempDir, 'openai-chat', providerKey, groupRequestId);

    expect(fs.existsSync(messagesDir)).toBe(true);
    expect(fs.existsSync(chatDir)).toBe(false);
  });
});
