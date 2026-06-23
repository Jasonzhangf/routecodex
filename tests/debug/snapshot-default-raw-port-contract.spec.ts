import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

import { runtimeFlags, setRuntimeFlag } from '../../src/runtime/runtime-flags.js';
import { writeServerSnapshot } from '../../src/utils/snapshot-writer.js';
import {
  __flushProviderSnapshotQueueForTests,
  __resetProviderSnapshotQueueForTests,
  writeClientSnapshot,
  writeProviderSnapshot
} from '../../src/providers/core/utils/snapshot-writer.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  allowSnapshotLocalDiskWrite
} from '../../src/utils/snapshot-local-disk-gate.js';

const writeSnapshotViaHooksMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: writeSnapshotViaHooksMock
}));

describe('snapshot default raw + port contract', () => {
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
  const originalSnapshotsEnabled = runtimeFlags.snapshotsEnabled;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-snapshot-default-raw-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    writeSnapshotViaHooksMock.mockReset();
    __resetSnapshotLocalDiskGateForTests();
    __resetProviderSnapshotQueueForTests();
  });

  afterEach(async () => {
    if (originalSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalSnapshotDir;
    }
    if (originalCompatSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = originalCompatSnapshotDir;
    }
    setRuntimeFlag('snapshotsEnabled', originalSnapshotsEnabled);
    __resetSnapshotLocalDiskGateForTests();
    __resetProviderSnapshotQueueForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('stores client-request raw body text under ports/<port>/<requestId>', async () => {
    const requestId = 'req_client_request_raw_default';
    allowSnapshotLocalDiskWrite(requestId);

    await writeClientSnapshot({
      entryEndpoint: '/v1/responses',
      requestId,
      headers: { 'content-type': 'application/json' },
      body: { input: 'parsed-body-should-not-be-primary-raw' },
      rawBodyText: '{"input":"true-raw-body"}',
      metadata: {
        matchedPort: 5555,
        stream: false
      }
    });

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      'client-request.json'
    );
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { bodyText?: string; body?: Record<string, unknown> };

    expect(parsed.bodyText).toContain('"input":"true-raw-body"');
    expect(raw).not.toContain('parsed-body-should-not-be-primary-raw');
  });

  it('does not collapse oversized client-request payloads into meta-only snapshots', async () => {
    const previousMaxBytes = process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = '1024';
    try {
      const requestId = 'req_client_request_oversize_explicit';
      allowSnapshotLocalDiskWrite(requestId);

      await writeClientSnapshot({
        entryEndpoint: '/v1/responses',
        requestId,
        headers: { accept: 'application/json' },
        body: {
          model: 'gpt-5.4',
          input: Array.from({ length: 48 }, (_, idx) => ({
            role: 'user',
            content: [{ type: 'input_text', text: `chunk-${idx}-${'x'.repeat(256)}` }]
          })),
          tools: Array.from({ length: 12 }, (_, idx) => ({
            type: 'function',
            name: `tool_${idx}`,
            description: 'd'.repeat(256)
          }))
        },
        metadata: {
          matchedPort: 5555,
          stream: true
        }
      });

      const filePath = path.join(
        tempDir,
        'openai-responses',
        'ports',
        '5555',
        requestId,
        'client-request.json'
      );
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        body?: unknown;
        bodyText?: string;
        oversize?: {
          kind?: string;
          droppedBecause?: string;
          estimatedBytes?: number;
          maxBytes?: number;
          summary?: Record<string, unknown>;
        };
        headers?: Record<string, unknown>;
        url?: string;
      };

      expect(parsed.body).toBeUndefined();
      expect(parsed.bodyText).toBeUndefined();
      expect(parsed.url).toBe('/v1/responses');
      expect(parsed.headers).toMatchObject({ accept: 'application/json' });
      expect(parsed.oversize).toMatchObject({
        kind: 'snapshot_payload_oversize',
        droppedBecause: 'payload_max_bytes_exceeded',
        maxBytes: 1024
      });
      expect(parsed.oversize?.estimatedBytes).toBeGreaterThan(1024);
      expect(parsed.oversize?.summary).toMatchObject({
        type: 'provider-request',
        requestShape: {
          model: 'gpt-5.4',
          toolsCount: 12
        }
      });
      expect(raw).not.toContain('"body":');
      expect(raw).not.toContain('"bodyText":');
    } finally {
      if (previousMaxBytes === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = previousMaxBytes;
      }
    }
  });

  it('stores client-response snapshots under ports/<port>/<requestId> without provider-key path segment', async () => {
    const requestId = 'req_client_response_port_bucket';
    allowSnapshotLocalDiskWrite(requestId);

    await writeServerSnapshot({
      phase: 'client-response',
      requestId,
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: { status: 200, body: { ok: true } }
    });

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      'client-response.json'
    );

    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('"stage": "client-response"');
    await expect(
      fs.stat(path.join(tempDir, 'openai-responses', 'ports', '5555', 'fake-provider', requestId))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores provider-error snapshots under ports/<port>/<requestId> and rejects root-level fallback', async () => {
    const requestId = 'req_provider_error_port_bucket';
    allowSnapshotLocalDiskWrite(requestId);

    await writeProviderSnapshot({
      phase: 'provider-error',
      requestId,
      clientRequestId: requestId,
      entryEndpoint: '/v1/responses',
      providerKey: 'mock.provider',
      headers: { 'content-type': 'application/json' },
      data: { status: 503, code: 'HTTP_503' },
      url: 'https://example.invalid/v1/responses',
      metadata: {
        routecodexLocalPort: 5555
      }
    });
    await __flushProviderSnapshotQueueForTests();

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      'provider-error.json'
    );

    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('"stage": "provider-error"');
    await expect(
      fs.stat(path.join(tempDir, 'openai-responses', requestId, 'provider-error.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
