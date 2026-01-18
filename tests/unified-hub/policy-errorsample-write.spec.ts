import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSnapshotRecorder } from '../../src/modules/llmswitch/bridge.js';

async function waitForFile(dir: string, predicate: (name: string) => boolean, timeoutMs = 1500): Promise<string> {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const entries = await fs.readdir(dir);
      const match = entries.find(predicate);
      if (match) return path.join(dir, match);
    } catch {
      // ignore while waiting
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for file in ${dir}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('hub policy observation errorsamples', () => {
  let snapshotDir: string;
  let errorsDir: string;

  beforeEach(async () => {
    snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshots-'));
    errorsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = snapshotDir;
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
  });

  afterEach(async () => {
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await fs.rm(errorsDir, { recursive: true, force: true });
  });

  it('writes an errorsample when hub_policy stage contains violations', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_policy_1',
        providerId: 'mock',
        providerProtocol: 'openai-chat',
        runtime: { test: true }
      },
      '/v1/chat/completions'
    );

    (recorder as any).record('hub_policy.observe.provider_outbound', {
      requestId: 'req_policy_1',
      providerProtocol: 'openai-chat',
      violations: [{ code: 'unexpected_field', path: 'choices' }],
      summary: { totalViolations: 1, unexpectedFieldCount: 1 }
    });

    const policyDir = path.join(errorsDir, 'policy');
    const file = await waitForFile(policyDir, (name) => name.startsWith('hub_policy.observe.provider_outbound-'));
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('hub_policy_violation');
    expect(json.stage).toBe('hub_policy.observe.provider_outbound');
    expect(json.endpoint).toBe('/v1/chat/completions');
    expect(Array.isArray(json.observation?.violations)).toBe(true);
  });
});

