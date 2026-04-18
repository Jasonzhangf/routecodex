import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureSnapshotRuntimeMarker } from '../../../src/utils/snapshot-request-retention.js';

describe('snapshot runtime marker', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('writes valid runtime metadata once and preserves the first payload', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-runtime-marker-'));

    await ensureSnapshotRuntimeMarker(tempDir, {
      requestId: 'req_runtime_marker_first',
      groupRequestId: 'req_runtime_marker_group',
      providerKey: 'ali-coding-plan.key1.glm-5'
    });
    await ensureSnapshotRuntimeMarker(tempDir, {
      requestId: 'req_runtime_marker_second',
      groupRequestId: 'req_runtime_marker_group_2',
      providerKey: 'ali-coding-plan.key1.qwen3.6-plus'
    });

    const raw = await fs.readFile(path.join(tempDir, '__runtime.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      requestId?: string;
      groupRequestId?: string;
      providerKey?: string;
      versions?: Record<string, unknown>;
    };

    expect(parsed.requestId).toBe('req_runtime_marker_first');
    expect(parsed.groupRequestId).toBe('req_runtime_marker_group');
    expect(parsed.providerKey).toBe('ali-coding-plan.key1.glm-5');
    expect(parsed.versions).toBeTruthy();
    expect(raw.includes('req_runtime_marker_second')).toBe(false);
  });
});
