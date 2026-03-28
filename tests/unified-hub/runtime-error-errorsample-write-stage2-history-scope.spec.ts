import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSnapshotRecorder,
  resetSnapshotRecorderErrorsampleStateForTests
} from '../../src/modules/llmswitch/bridge.js';

describe('runtime errorsample stage2 current-tail scope', () => {
  let snapshotDir: string;
  let errorsDir: string;

  beforeEach(async () => {
    snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshots-'));
    errorsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = snapshotDir;
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
  });

  afterEach(async () => {
    resetSnapshotRecorderErrorsampleStateForTests();
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    delete process.env.ROUTECODEX_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
    delete process.env.RCC_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await fs.rm(errorsDir, { recursive: true, force: true });
  });

  it('ignores historical tool failures once newer assistant/user turns exist after them', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_stage2_history_scope_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'exec_command',
          tool_call_id: 'fc_reasoning_choice_1_1',
          call_id: 'fc_reasoning_choice_1_1',
          content: 'failed to parse function arguments: missing field `cmd` at line 1 column 2'
        },
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_old_1',
          call_id: 'call_apply_patch_old_1',
          content:
            "apply_patch verification failed: invalid hunk at line 2, Update file hunk for path 'src/server/modules/progress-monitor.ts' is empty"
        },
        {
          role: 'assistant',
          content: '继续执行'
        },
        {
          role: 'user',
          content: '继续，并检查新闻脚本'
        }
      ]
    });

    await new Promise((r) => setTimeout(r, 180));
    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const entries = await fs.readdir(clientToolDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });
});
