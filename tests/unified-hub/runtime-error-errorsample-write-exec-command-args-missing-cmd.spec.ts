import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

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

describe('runtime errorsample exec_command args missing cmd', () => {
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

  it('writes one sample and one condensed console line for repeated missing-cmd parse failures', async () => {
    process.env.ROUTECODEX_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS = '3600000';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = await createSnapshotRecorder(
        {
          requestId: 'req_exec_command_missing_cmd_1',
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
            tool_call_id: 'call_exec_cmd_missing_1',
            call_id: 'call_exec_cmd_missing_1',
            content: 'failed to parse function arguments: missing field `cmd` at line 1 column 65'
          },
          {
            role: 'tool',
            name: 'exec_command',
            tool_call_id: 'call_exec_cmd_missing_2',
            call_id: 'call_exec_cmd_missing_2',
            content:
              'failed to parse function arguments: missing field `cmd` (more client-tool errors suppressed for this request; see ~/.rcc/errorsamples/client-tool-error/)'
          }
        ]
      });

      const clientToolDir = path.join(errorsDir, 'client-tool-error');
      const file = await waitForFile(clientToolDir, 'chat_process.req.stage2.semantic_map.exec_command-');
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as any;

      expect(json.toolName).toBe('exec_command');
      expect(json.errorType).toBe('exec_command_args_missing_cmd');
      expect(String(json.matchedText || '')).toContain('missing field `cmd`');

      await new Promise((r) => setTimeout(r, 120));
      const entries = (await fs.readdir(clientToolDir)).filter((name) =>
        name.startsWith('chat_process.req.stage2.semantic_map.exec_command-')
      );
      expect(entries).toHaveLength(1);

      const lines = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[client-tool-error]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('errorType=exec_command_args_missing_cmd');
      expect(lines[0]).toContain('detail=missing field `cmd`');
      expect(lines[0]).toContain('suppressed for this request');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not misclassify transcript output that only echoes missing-cmd text', async () => {
    const recorder = await createSnapshotRecorder(
      {
        requestId: 'req_exec_command_missing_cmd_transcript_1',
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
          tool_call_id: 'call_exec_cmd_transcript_1',
          call_id: 'call_exec_cmd_transcript_1',
          content:
            'Chunk ID: f9ed9c\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\nfailed to parse function arguments: missing field `cmd`'
        }
      ]
    });

    await new Promise((r) => setTimeout(r, 180));
    const clientToolDir = path.join(errorsDir, 'client-tool-error');
    await expect(fs.readdir(clientToolDir)).rejects.toThrow();
  });
});
