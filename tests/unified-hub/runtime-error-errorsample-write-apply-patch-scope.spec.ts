import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSnapshotRecorder,
  resetSnapshotRecorderErrorsampleStateForTests
} from '../../src/modules/llmswitch/bridge.js';

async function waitForFile(dir: string, prefix: string, timeoutMs = 1500): Promise<string> {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const entries = await fs.readdir(dir);
      const hit = entries.find((name) => name.startsWith(prefix));
      if (hit) {
        return path.join(dir, hit);
      }
    } catch {
      // ignore until timeout
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for file in ${dir} with prefix ${prefix}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runtime errorsample apply_patch scope', () => {
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

  it('does not write client-tool-error samples for apply_patch context-drift failures', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_drift_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_drift_1',
          call_id: 'call_apply_patch_drift_1',
          content:
            "apply_patch verification failed: Failed to find context '-119,7 +119,6 @@' in /Volumes/extension/code/finger/src/server/modules/agent-status-subscriber.ts"
        },
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_drift_2',
          call_id: 'call_apply_patch_drift_2',
          content:
            'apply_patch verification failed: Failed to find expected lines in /Volumes/extension/code/finger/src/server/modules/channel-bridge-hub-route.ts: const sendReply = async (...)'
        }
      ]
    });

    await new Promise((r) => setTimeout(r, 180));
    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    await expect(fs.readdir(clientToolDir)).rejects.toThrow();
  });

  it('writes client-tool-error sample for apply_patch empty update hunk subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_empty_update_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_empty_update_1',
          call_id: 'call_apply_patch_empty_update_1',
          content:
            "apply_patch verification failed: invalid hunk at line 2, Update file hunk for path 'src/tools/internal/index.ts' is empty"
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(clientToolDir, 'chat_process.req.stage2.semantic_map.apply_patch-');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_empty_update_hunk');
    expect(String(json.matchedText || '')).toContain('Update file hunk');
  });

  it('writes client-tool-error sample for legacy context-diff hunk header subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_legacy_context_hunk_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_legacy_context_hunk_1',
          call_id: 'call_apply_patch_legacy_context_hunk_1',
          content:
            "apply_patch verification failed: invalid hunk at line 2, '*** 55,61 ****' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(clientToolDir, 'chat_process.req.stage2.semantic_map.apply_patch-');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_legacy_context_diff_hunk_header');
    expect(String(json.matchedText || '')).toContain('*** 55,61 ****');
  });

  it('writes runtime exec-error sample for legacy context-diff hunk header subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_runtime_apply_patch_legacy_context_hunk_1',
        providerId: 'mock',
        providerProtocol: 'openai-chat'
      },
      '/v1/chat/completions'
    );

    (recorder as any).record('chat_process.resp.stage7.tool_governance', {
      error: {
        detail:
          "apply_patch verification failed: invalid hunk at line 2, '*** 55,61 ****' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"
      }
    });

    const execDir = path.join(errorsDir, 'exec-error');
    const file = await waitForFile(execDir, 'chat_process.resp.stage7.tool_governance-');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_legacy_context_diff_hunk_header');
    expect(String(json.matchedText || '')).toContain('*** 55,61 ****');
  });

  it('writes client-tool-error sample for legacy update header missing "File" keyword subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_legacy_update_header_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_legacy_update_header_1',
          call_id: 'call_apply_patch_legacy_update_header_1',
          content:
            "apply_patch verification failed: invalid hunk at line 2, '*** Update src/core/user-settings.ts' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(clientToolDir, 'chat_process.req.stage2.semantic_map.apply_patch-');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_legacy_update_header_missing_file_keyword');
    expect(String(json.matchedText || '')).toContain('*** Update src/core/user-settings.ts');
  });

  it('writes client-tool-error sample for missing @@ hunk context-marker subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_missing_hunk_marker_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_missing_hunk_marker_1',
          call_id: 'call_apply_patch_missing_hunk_marker_1',
          content:
            "apply_patch verification failed: invalid hunk at line 4, Expected update hunk to start with a @@ context marker, got: 'title: \"System Agent HEARTBEAT\"'"
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(clientToolDir, 'chat_process.req.stage2.semantic_map.apply_patch-');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_missing_hunk_context_marker');
    expect(String(json.matchedText || '')).toContain('Expected update hunk to start with a @@ context marker');
  });

  it('writes client-tool-error sample for legacy new-file header subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_legacy_new_file_header_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'apply_patch',
          tool_call_id: 'call_apply_patch_legacy_new_file_header_1',
          call_id: 'call_apply_patch_legacy_new_file_header_1',
          content:
            "apply_patch verification failed: invalid hunk at line 2, '*** New File: tests/unit/server/finger-role-modules-prompt-overrides.test.ts' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(clientToolDir, 'chat_process.req.stage2.semantic_map.apply_patch-');
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_legacy_new_file_header');
    expect(String(json.matchedText || '')).toContain('*** New File: tests/unit/server/finger-role-modules-prompt-overrides.test.ts');
  });
});
