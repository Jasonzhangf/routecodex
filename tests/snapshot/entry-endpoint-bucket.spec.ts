import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeProviderSnapshot } from '../../src/providers/core/utils/snapshot-writer.ts';
import { setRuntimeFlag } from '../../src/runtime/runtime-flags.ts';
import { writeSnapshotViaHooks } from '../../src/modules/llmswitch/bridge.ts';

describe('codex-samples snapshot bucket uses entry endpoint', () => {
  const prevSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const prevSnapshotDirCompat = process.env.RCC_SNAPSHOT_DIR;
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-snapshot-entry-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
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

  test('host provider snapshot buckets by entry endpoint, not upstream url', async () => {
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

  test('hub snapshot hook ignores nested endpoint fields and keeps entry bucket', async () => {
    const groupRequestId = 'req_snapshot_bucket_messages_2';
    const providerKey = 'iflow.2-173.minimax-m2.5';
    await writeSnapshotViaHooks({
      endpoint: '/v1/messages',
      stage: 'entry-endpoint-bucket-check',
      requestId: groupRequestId,
      groupRequestId,
      providerKey,
      data: {
        endpoint: 'https://apis.iflow.cn/v1/chat/completions',
        meta: {
          context: {
            endpoint: '/v1/chat/completions'
          }
        }
      },
      verbosity: 'verbose'
    });

    const messagesDir = path.join(tempDir, 'anthropic-messages', providerKey, groupRequestId);
    const chatDir = path.join(tempDir, 'openai-chat', providerKey, groupRequestId);

    expect(fs.existsSync(messagesDir)).toBe(true);
    expect(fs.existsSync(chatDir)).toBe(false);
  });
});
