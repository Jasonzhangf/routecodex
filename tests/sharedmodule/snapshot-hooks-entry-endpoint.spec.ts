import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeSnapshotViaHooks } from '../../sharedmodule/llmswitch-core/src/conversion/shared/snapshot-hooks.js';

describe('snapshot-hooks entryEndpoint folder routing', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshot-hooks-test-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
  });

  afterEach(async () => {
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers meta.entryEndpoint over endpoint when choosing top-level folder', async () => {
    await writeSnapshotViaHooks({
      endpoint: '/v1/messages',
      stage: 'provider-request',
      requestId: 'req_1',
      groupRequestId: 'grp_1',
      providerKey: 'anthropic.test',
      data: {
        meta: {
          entryEndpoint: '/v1/responses',
          groupRequestId: 'grp_1'
        },
        body: { ok: true }
      }
    });

    const folder = path.join(tempDir, 'openai-responses', 'anthropic.test', 'grp_1');
    const entries = await fs.readdir(folder);
    expect(entries.some((name) => name.startsWith('provider-request'))).toBe(true);
  });
});

