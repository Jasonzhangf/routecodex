import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { setRuntimeFlag, runtimeFlags } from '../../../../src/runtime/runtime-flags.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  allowSnapshotLocalDiskWrite
} from '../../../../src/utils/snapshot-local-disk-gate.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const writeSnapshotViaHooksMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  writeSnapshotViaHooks: writeSnapshotViaHooksMock
}));

describe('provider snapshot writer local mirror', () => {
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
  const originalSnapshotsEnabled = runtimeFlags.snapshotsEnabled;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-provider-snapshot-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    writeSnapshotViaHooksMock.mockReset();
    __resetSnapshotLocalDiskGateForTests();
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
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('materializes provider-response.json locally even when hook succeeds without writing files', async () => {
    const { writeProviderSnapshot } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const { __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_provider_snapshot_local_mirror';
    const providerKey = 'ali-coding-plan.key1.glm-5';
    const metadata = { routingPolicyGroup: 'gateway_priority_5555' };
    MetadataCenter.attach(metadata).writeRequestTruth(
      'portScope',
      '5555',
      {
        module: 'tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts',
        symbol: 'materializes provider-response locally from MetadataCenter portScope',
        stage: 'test'
      }
    );

    allowSnapshotLocalDiskWrite(requestId);

    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId,
      clientRequestId: requestId,
      entryEndpoint: '/v1/responses',
      providerKey,
      metadata,
      data: {
        mode: 'sse',
        captureSse: true,
        transport: 'upstream-stream'
      }
    });
    await __flushProviderSnapshotQueueForTests();

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      'provider-response.json'
    );
    const runtimePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      '__runtime.json'
    );
    const raw = await fs.readFile(filePath, 'utf-8');
    const runtimeRaw = await fs.readFile(runtimePath, 'utf-8');
    const parsed = JSON.parse(raw) as { meta?: Record<string, unknown>; body?: Record<string, unknown> };
    const runtimeParsed = JSON.parse(runtimeRaw) as Record<string, unknown>;

    expect(writeSnapshotViaHooksMock).toHaveBeenCalledTimes(1);
    expect(writeSnapshotViaHooksMock).toHaveBeenCalledWith(expect.objectContaining({ entryPort: 5555 }));
    expect(parsed.meta?.stage).toBe('provider-response');
    expect(parsed.meta?.entryPort).toBe(5555);
    expect(parsed.meta?.matchedPort).toBe(5555);
    expect(parsed.body).toMatchObject({
      mode: 'sse',
      captureSse: true,
      transport: 'upstream-stream'
    });
    expect(runtimeParsed.requestId).toBe(requestId);
    expect(runtimeParsed.groupRequestId).toBe(requestId);
    expect(runtimeParsed.providerKey).toBe(providerKey);
    expect(runtimeParsed.entryPort).toBe(5555);
    expect(runtimeParsed.matchedPort).toBe(5555);
  });

  it('writes provider-request repro snapshots without carrying request metadata or internal carriers', async () => {
    const { writeProviderSnapshot, __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_provider_snapshot_metadata_sanitize';
    const providerKey = 'minimax.key1.MiniMax-M3';
    const metadata = {
      __raw_request_body: { tools: [{ type: 'namespace', name: 'multi_agent_v1' }] },
      responsesRequestContext: {
        context: { toolsRaw: [{ type: 'namespace', name: 'multi_agent_v1' }] },
        payload: { tools: [{ type: 'namespace', name: 'multi_agent_v1' }] }
      },
      responsesContext: { toolsRaw: [{ type: 'namespace', name: 'multi_agent_v1' }] },
      contextSnapshot: { toolsRaw: [{ type: 'namespace', name: 'multi_agent_v1' }] },
      __rt: { sessionDir: '/tmp/rcc-internal-session' },
      metadata: { __rt: { nested: true }, snapshot: { debug: true } },
      portContext: { logNamespace: 'server-5555' }
    };
    MetadataCenter.attach(metadata).writeRequestTruth(
      'portScope',
      '5555',
      {
        module: 'tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts',
        symbol: 'does not write request metadata or internal carriers into provider snapshots',
        stage: 'test'
      }
    );

    allowSnapshotLocalDiskWrite(requestId);

    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId,
      clientRequestId: requestId,
      entryEndpoint: '/v1/responses',
      providerKey,
      metadata,
      data: { model: 'minimax-m3-free', messages: [{ role: 'user', content: 'ok' }] },
      forceLocalDiskWriteWhenDisabled: true
    });
    await __flushProviderSnapshotQueueForTests();

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      'provider-request.json'
    );
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { meta?: Record<string, unknown>; body?: Record<string, unknown> };

    expect(parsed.meta?.stage).toBe('provider-request');
    expect(parsed.body).toMatchObject({
      model: 'minimax-m3-free',
      messages: [{ role: 'user', content: 'ok' }]
    });
    expect(raw).not.toContain('__raw_request_body');
    expect(raw).not.toContain('responsesRequestContext');
    expect(raw).not.toContain('responsesContext');
    expect(raw).not.toContain('contextSnapshot');
    expect(raw).not.toContain('portContext');
    expect(raw).not.toContain('multi_agent_v1');
    expect(writeSnapshotViaHooksMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      entryPort: 5555,
      runtimeMetadata: expect.objectContaining({
        portScope: '5555'
      })
    }));
  });

  it('accepts explicit entryPort for provider-error snapshots even when metadata omits port fields', async () => {
    const { writeProviderSnapshot, __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_provider_snapshot_explicit_entry_port';
    const providerKey = 'glm-router.key1';

    allowSnapshotLocalDiskWrite(requestId);

    await writeProviderSnapshot({
      phase: 'provider-error',
      requestId,
      clientRequestId: requestId,
      entryEndpoint: '/v1/responses',
      providerKey,
      entryPort: 5555,
      metadata: {
        routeName: 'default'
      },
      data: { status: 503, code: 'HTTP_503' }
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
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { meta?: Record<string, unknown> };

    expect(parsed.meta?.entryPort).toBe(5555);
    expect(parsed.meta?.matchedPort).toBe(5555);
    expect(writeSnapshotViaHooksMock).toHaveBeenCalledWith(expect.objectContaining({
      entryPort: 5555
    }));
  });

  it('reads provider snapshot entryPort from MetadataCenter request_truth.portScope', async () => {
    const { writeProviderSnapshot, __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_provider_snapshot_metadata_center_port_scope';
    const providerKey = 'glm-router.key1';

    allowSnapshotLocalDiskWrite(requestId);

    const metadata = {};
    MetadataCenter.attach(metadata).writeRequestTruth(
      'portScope',
      '5555',
      {
        module: 'tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts',
        symbol: 'reads provider snapshot entryPort from MetadataCenter request_truth.portScope',
        stage: 'test'
      }
    );

    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId,
      clientRequestId: requestId,
      entryEndpoint: '/v1/responses',
      providerKey,
      metadata,
      data: { mode: 'sse', transport: 'upstream-stream' }
    });
    await __flushProviderSnapshotQueueForTests();

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5555',
      requestId,
      'provider-response.json'
    );
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { meta?: Record<string, unknown> };

    expect(parsed.meta?.entryPort).toBe(5555);
    expect(parsed.meta?.matchedPort).toBe(5555);
    expect(writeSnapshotViaHooksMock).toHaveBeenCalledWith(expect.objectContaining({
      entryPort: 5555
    }));
  });

  it('rejects provider snapshot entryPort from current port request context without MetadataCenter truth', async () => {
    const { writeProviderSnapshot, __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_provider_snapshot_current_port_context';
    const providerKey = 'glm-router.key1';

    allowSnapshotLocalDiskWrite(requestId);

    await expect(
      writeProviderSnapshot({
        phase: 'provider-response',
        requestId,
        clientRequestId: requestId,
        entryEndpoint: '/v1/responses',
        providerKey,
        metadata: {},
        data: { mode: 'sse', transport: 'upstream-stream' }
      })
    ).rejects.toThrow('entryPort required for stage=provider-response');
    await __flushProviderSnapshotQueueForTests();

    const filePath = path.join(
      tempDir,
      'openai-responses',
      'ports',
      '5520',
      requestId,
      'provider-response.json'
    );
    await expect(fs.readFile(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(writeSnapshotViaHooksMock).not.toHaveBeenCalledWith(expect.objectContaining({
      entryPort: 5520
    }));
  });

  it('rejects client snapshots when MetadataCenter has no request_truth.portScope', async () => {
    const { writeClientSnapshot } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_client_snapshot_missing_metadata_center_port';

    allowSnapshotLocalDiskWrite(requestId);

    await expect(
      writeClientSnapshot({
        entryEndpoint: '/v1/responses',
        requestId,
        headers: { 'content-type': 'application/json' },
        body: { input: 'missing port truth' },
        metadata: {}
      })
    ).rejects.toThrow('entryPort required for stage=client-request');

    await expect(fs.readFile(
      path.join(tempDir, 'openai-responses', 'ports', '5520', requestId, 'client-request.json'),
      'utf-8'
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps provider snapshot entryPort resolution free of current request context fallback', async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), 'src/debug/snapshot/provider-writer.ts'),
      'utf-8'
    );

    expect(source).not.toContain('getCurrentPortRequestContext');
    expect(source).not.toContain('metadata.matchedPort');
    expect(source).not.toContain('metadata.routecodexLocalPort');
    expect(source).not.toContain('metadata.portScope');
  });
});
