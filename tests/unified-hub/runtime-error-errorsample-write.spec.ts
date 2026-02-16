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

  it('writes client-tool-error sample with stage trace for exec_command failures', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [{ role: 'user', content: 'hello' }]
    });
    (recorder as any).record('chat_process.req.stage6.outbound.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'exec_command',
          tool_call_id: 'exec_command:1',
          call_id: 'exec_command:1',
          content: 'Chunk ID: test\nProcess exited with code 2\nOutput: permission denied'
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(
      clientToolDir,
      (name) => name.startsWith('chat_process.req.stage6.outbound.semantic_map.exec_command-')
    );
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('client_tool_execution_error');
    expect(json.toolName).toBe('exec_command');
    expect(json.errorType).toBe('exec_command_non_zero_exit');
    expect(json.requestId).toBe('req_client_tool_1');
    expect(json.stage).toBe('chat_process.req.stage6.outbound.semantic_map');
    expect(Array.isArray(json.trace)).toBe(true);
    expect(json.trace.length).toBeGreaterThanOrEqual(2);
    expect(json.trace[0].stage).toBe('chat_process.req.stage2.semantic_map');
    expect(json.trace[json.trace.length - 1].stage).toBe('chat_process.req.stage6.outbound.semantic_map');
  });

  it('writes client-tool-error sample for shell_command argument validation failure', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_shell_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'tool',
          name: 'shell_command',
          tool_call_id: 'call_shell_1',
          call_id: 'call_shell_1',
          content: 'failed to parse function arguments: missing field `command` at line 1 column 65'
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(
      clientToolDir,
      (name) => name.startsWith('chat_process.req.stage2.semantic_map.shell_command-')
    );
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('client_tool_execution_error');
    expect(json.toolName).toBe('shell_command');
    expect(json.errorType).toBe('shell_command_args_missing_command');
    expect(json.requestId).toBe('req_client_tool_shell_1');
    expect(json.stage).toBe('chat_process.req.stage2.semantic_map');
  });
});
