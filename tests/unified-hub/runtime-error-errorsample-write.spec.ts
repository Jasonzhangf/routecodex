import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

import {
  createSnapshotRecorder,
  resetSnapshotRecorderErrorsampleStateForTests
} from '../../src/modules/llmswitch/bridge.js';

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
    resetSnapshotRecorderErrorsampleStateForTests();
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    delete process.env.ROUTECODEX_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
    delete process.env.RCC_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
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
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = await createSnapshotRecorder(
        {
          requestId: 'req_exec_1',
          providerId: 'mock',
          providerProtocol: 'openai-chat'
        },
        '/v1/chat/completions'
      );

      (recorder as any).record('chat_process.resp.stage7.tool_governance', {
        error: {
          detail: 'apply_patch verification failed: invalid patch'
        },
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
      const runtimeLines = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[runtime-error]'));
      expect(runtimeLines).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
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
    expect(json.trace.every((entry: any) => !Object.prototype.hasOwnProperty.call(entry, 'payload'))).toBe(true);
    expect(json.observation.toolMessageCount).toBe(1);
    expect(Array.isArray(json.observation.toolMessages)).toBe(true);
  });

  it('ignores transcript-like successful exec_command output even if output text contains parse-failure keywords', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_transcript_noise',
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
          tool_call_id: 'exec_command:noise',
          call_id: 'exec_command:noise',
          content:
            'Chunk ID: f9ed9c\\nWall time: 0.0000 seconds\\nProcess exited with code 0\\nOutput:\\nfailed to parse function arguments: missing field `cmd`'
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    await new Promise((r) => setTimeout(r, 180));
    const entries = (await fs.readdir(clientToolDir).catch(() => [])).filter((name) =>
      name.includes('req_client_tool_transcript_noise')
    );
    expect(entries.length).toBe(0);
  });

  it('does not log client-tool-error console line for normal execution failures', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = await createSnapshotRecorder(
        {
          requestId: 'req_client_tool_console_once_1',
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
            tool_call_id: 'exec_command:1',
            call_id: 'exec_command:1',
            content: 'Chunk ID: one\nProcess exited with code 1\nOutput: failed'
          },
          {
            role: 'tool',
            name: 'exec_command',
            tool_call_id: 'exec_command:2',
            call_id: 'exec_command:2',
            content: 'Chunk ID: two\nProcess exited with code 2\nOutput: failed'
          }
        ]
      });

      const clientToolDir = path.join(errorsDir, 'client-tool-error');
      await waitForFile(
        clientToolDir,
        (name) => name.startsWith('chat_process.req.stage2.semantic_map.exec_command-')
      );
      await new Promise((r) => setTimeout(r, 120));
      const entries = (await fs.readdir(clientToolDir)).filter((name) =>
        name.startsWith('chat_process.req.stage2.semantic_map.exec_command-')
      );
      expect(entries.length).toBe(1);

      const clientToolConsoleLines = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[client-tool-error]'));
      expect(clientToolConsoleLines).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('skips errorsample write for low-value exec_command exit code 1 noise', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_exec_code1_skip',
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
          tool_call_id: 'exec_command:skip',
          call_id: 'exec_command:skip',
          content: 'Chunk ID: skip\nProcess exited with code 1\nOutput: failed'
        }
      ]
    });

    await new Promise((r) => setTimeout(r, 120));
    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const files = await fs.readdir(clientToolDir).catch(() => []);
    expect(files.some((name) => name.startsWith('chat_process.req.stage2.semantic_map.exec_command-'))).toBe(false);
  });

  it('logs one condensed client-tool-error console line for apply_patch parse failures only', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = await createSnapshotRecorder(
        {
          requestId: 'req_client_tool_console_parse_only_1',
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
            tool_call_id: 'call_apply_patch_parse_1',
            call_id: 'call_apply_patch_parse_1',
            content: 'failed to parse function arguments: missing field `input` at line 1 column 65'
          },
          {
            role: 'tool',
            name: 'apply_patch',
            tool_call_id: 'call_apply_patch_exec_1',
            call_id: 'call_apply_patch_exec_1',
            content: 'apply_patch verification failed: invalid hunk at line 2'
          }
        ]
      });

      const clientToolConsoleLines = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[client-tool-error]'));
      expect(clientToolConsoleLines).toHaveLength(1);
      expect(clientToolConsoleLines[0]).toContain('apply_patch_args_missing_input');
      expect(clientToolConsoleLines[0]).toContain('suppressed for this request');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs one condensed client-tool-error console line for exec_command parse failures', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = await createSnapshotRecorder(
        {
          requestId: 'req_client_tool_console_exec_parse_1',
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
            tool_call_id: 'call_exec_parse_1',
            call_id: 'call_exec_parse_1',
            content: 'failed to parse function arguments: missing field `cmd` at line 1 column 65'
          },
          {
            role: 'tool',
            name: 'exec_command',
            tool_call_id: 'call_exec_runtime_1',
            call_id: 'call_exec_runtime_1',
            content: 'Chunk ID: one\nProcess exited with code 1\nOutput: failed'
          }
        ]
      });

      const clientToolConsoleLines = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[client-tool-error]'));
      expect(clientToolConsoleLines).toHaveLength(1);
      expect(clientToolConsoleLines[0]).toContain('exec_command_args_missing_cmd');
      expect(clientToolConsoleLines[0]).toContain('suppressed for this request');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('suppresses duplicate client-tool-error samples across requests within the sample window', async () => {
    process.env.ROUTECODEX_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS = '3600000';

    const recorderA = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_window_1',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );
    const recorderB = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_window_2',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    const payload = {
      messages: [
        {
          role: 'tool',
          name: 'exec_command',
          tool_call_id: 'exec_command:1',
          call_id: 'exec_command:1',
          content: 'Chunk ID: one\nProcess exited with code 2\nOutput: failed'
        }
      ]
    };

    (recorderA as any).record('chat_process.req.stage2.semantic_map', payload);
    (recorderB as any).record('chat_process.req.stage2.semantic_map', payload);

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    await waitForFile(
      clientToolDir,
      (name) => name.startsWith('chat_process.req.stage2.semantic_map.exec_command-')
    );
    await new Promise((r) => setTimeout(r, 120));
    const entries = (await fs.readdir(clientToolDir)).filter((name) =>
      name.startsWith('chat_process.req.stage2.semantic_map.exec_command-')
    );
    expect(entries).toHaveLength(1);
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

  it('writes client-tool-error sample for apply_patch argument parse failure', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_parse_1',
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
          tool_call_id: 'call_apply_patch_1',
          call_id: 'call_apply_patch_1',
          content: 'failed to parse function arguments: missing field `input` at line 1 column 65'
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(
      clientToolDir,
      (name) => name.startsWith('chat_process.req.stage2.semantic_map.apply_patch-')
    );
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('client_tool_execution_error');
    expect(json.toolName).toBe('apply_patch');
    expect(json.errorType).toBe('apply_patch_args_missing_input');
    expect(json.requestId).toBe('req_client_tool_apply_patch_parse_1');
    expect(json.stage).toBe('chat_process.req.stage2.semantic_map');
  });

  it('classifies apply_patch mixed GNU diff verification failures into a stable subtype', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_client_tool_apply_patch_mixed_gnu_1',
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
          tool_call_id: 'call_apply_patch_mixed_gnu_1',
          call_id: 'call_apply_patch_mixed_gnu_1',
          content:
            "apply_patch verification failed: invalid hunk at line 2, '--- a/src/server/index.ts' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"
        }
      ]
    });

    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    const file = await waitForFile(
      clientToolDir,
      (name) => name.startsWith('chat_process.req.stage2.semantic_map.apply_patch-')
    );
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.errorType).toBe('apply_patch_mixed_gnu_diff_inside_begin_patch');
    expect(String(json.matchedText || '')).toContain("'--- a/src/server/index.ts'");
  });

  it('classifies runtime exec-error apply_patch conflict-marker failures into a stable subtype', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = await createSnapshotRecorder(
        {
          requestId: 'req_exec_apply_patch_conflict_1',
          providerId: 'mock',
          providerProtocol: 'openai-chat'
        },
        '/v1/chat/completions'
      );

      (recorder as any).record('chat_process.resp.stage7.tool_governance', {
        error: {
          detail:
            "apply_patch verification failed: invalid hunk at line 19, Expected update hunk to start with a @@ context marker, got: '======='"
        }
      });

      const execDir = path.join(errorsDir, 'exec-error');
      const file = await waitForFile(execDir, (name) => name.startsWith('chat_process.resp.stage7.tool_governance-'));
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
      expect(json.errorType).toBe('apply_patch_conflict_markers_or_merge_chunks');
      const runtimeLines = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[runtime-error]'));
      expect(runtimeLines).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not classify user-echoed followup failure text from message content as runtime error', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_false_positive_followup',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.req.stage2.semantic_map', {
      messages: [
        {
          role: 'user',
          content:
            '[runtime-error] requestId=rid group=exec-error stage=chat_process.resp.stage7.tool_governance errorType=followup_execution_failed detail=followup failed for flow'
        }
      ],
      metadata: {
        note: 'quoted logs only'
      }
    });

    await new Promise((r) => setTimeout(r, 150));
    const execDir = path.join(errorsDir, 'exec-error');
    await expect(fs.readdir(execDir)).rejects.toThrow();
  });

  it('still classifies structured followup failure text from error fields as runtime error', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_true_positive_followup',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.resp.stage7.tool_governance', {
      error: {
        detail: 'followup failed for flow review_flow'
      },
      message: 'servertool followup execution failed'
    });

    const execDir = path.join(errorsDir, 'exec-error');
    const file = await waitForFile(execDir, (name) => name.startsWith('chat_process.resp.stage7.tool_governance-'));
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;
    expect(json.kind).toBe('runtime_exec_error');
    expect(json.errorType).toBe('followup_execution_failed');
    expect(json.requestId).toBe('req_true_positive_followup');
    expect(json.stage).toBe('chat_process.resp.stage7.tool_governance');
  });

  it('does not classify followup text echoed from tool call arguments as runtime error', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_false_positive_tool_args',
        providerId: 'mock',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );

    (recorder as any).record('chat_process.resp.stage7.tool_governance', {
      governedPayload: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: JSON.stringify({
                      cmd: 'echo followup failed for flow'
                    })
                  }
                }
              ]
            }
          }
        ]
      }
    });

    await new Promise((r) => setTimeout(r, 150));
    const execDir = path.join(errorsDir, 'exec-error');
    await expect(fs.readdir(execDir)).rejects.toThrow();
  });
});
