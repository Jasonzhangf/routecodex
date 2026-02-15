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

describe('runtime parse/exec errorsamples', () => {
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

  it('writes parse-error sample for SSE decode failure snapshot', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_parse_1',
        providerId: 'mock',
        providerProtocol: 'anthropic-messages'
      },
      '/v1/messages'
    );

    (recorder as any).record('chat_process.resp.stage1.sse_decode', {
      streamDetected: true,
      decoded: false,
      protocol: 'anthropic-messages',
      error: 'Anthropic SSE error event [500] Operation failed'
    });

    const parseDir = path.join(errorsDir, 'parse-error');
    const file = await waitForFile(parseDir, (name) => name.startsWith('chat_process.resp.stage1.sse_decode-'));
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('runtime_parse_error');
    expect(json.errorType).toBe('sse_decode_error');
    expect(json.requestId).toBe('req_parse_1');
    expect(json.stage).toBe('chat_process.resp.stage1.sse_decode');
  });

  it('writes exec-error sample for apply_patch verification failure', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_exec_1',
        providerId: 'mock',
        providerProtocol: 'openai-chat'
      },
      '/v1/chat/completions'
    );

    (recorder as any).record('chat_process.resp.stage7.tool_governance', {
      governedPayload: {
        choices: [
          {
            message: {
              role: 'tool',
              name: 'apply_patch',
              content: 'apply_patch verification failed: invalid patch'
            }
          }
        ]
      }
    });

    const execDir = path.join(errorsDir, 'exec-error');
    const file = await waitForFile(execDir, (name) => name.startsWith('chat_process.resp.stage7.tool_governance-'));
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('runtime_exec_error');
    expect(json.errorType).toBe('apply_patch_verification_failed');
    expect(json.requestId).toBe('req_exec_1');
    expect(json.stage).toBe('chat_process.resp.stage7.tool_governance');
  });

  it('deduplicates identical runtime error signal in same request', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_parse_dedup',
        providerId: 'mock',
        providerProtocol: 'anthropic-messages'
      },
      '/v1/messages'
    );

    const stagePayload = {
      streamDetected: true,
      decoded: false,
      protocol: 'anthropic-messages',
      error: 'Anthropic SSE error event [500] Operation failed'
    };
    (recorder as any).record('chat_process.resp.stage1.sse_decode', stagePayload);
    (recorder as any).record('chat_process.resp.stage1.sse_decode', stagePayload);

    const parseDir = path.join(errorsDir, 'parse-error');
    await waitForFile(parseDir, (name) => name.startsWith('chat_process.resp.stage1.sse_decode-'));
    await new Promise((r) => setTimeout(r, 120));
    const entries = (await fs.readdir(parseDir)).filter((name) =>
      name.startsWith('chat_process.resp.stage1.sse_decode-')
    );
    expect(entries.length).toBe(1);
  });
});
