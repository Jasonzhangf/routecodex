import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
  clearPendingServerToolInjection,
  loadPendingServerToolInjection,
  savePendingServerToolInjection
} from '../../sharedmodule/llmswitch-core/src/servertool/pending-session.js';

describe('servertool pending-session', () => {
  let sessionDir = '';
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-pending-session-'));
    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
  });

  afterEach(async () => {
    process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    await clearPendingServerToolInjection('sess-valid');
    await clearPendingServerToolInjection('sess-synthetic');
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  test('loads valid pending servertool injection unchanged', async () => {
    await savePendingServerToolInjection('sess-valid', {
      createdAtMs: Date.now(),
      afterToolCallIds: ['call_client_1'],
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_servertool_clock_req_1',
              type: 'function',
              function: {
                name: 'clock',
                arguments: '{"action":"list","items":[],"taskId":""}'
              }
            }
          ]
        },
        {
          role: 'tool',
          name: 'clock',
          tool_call_id: 'call_servertool_clock_req_1',
          content: '{"items":[]}'
        }
      ]
    });

    const loaded = await loadPendingServerToolInjection('sess-valid');
    expect(loaded).not.toBeNull();
    expect(loaded?.afterToolCallIds).toEqual(['call_client_1']);
    expect((loaded?.messages?.[0] as any)?.tool_calls?.[0]?.id).toBe('call_servertool_clock_req_1');
  });

  test('loads synthetic-looking pending injection unchanged because tool semantics are validated by Rust pipeline', async () => {
    await savePendingServerToolInjection('sess-synthetic', {
      createdAtMs: Date.now(),
      afterToolCallIds: ['call_servertool_fallback_1777378574502_510'],
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_servertool_fallback_1777378574502_510',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_servertool_fallback_1777378574502_510',
          name: 'exec_command',
          content: '{"stdout":"/tmp"}'
        }
      ]
    });

    const loaded = await loadPendingServerToolInjection('sess-synthetic');
    expect(loaded).not.toBeNull();
    expect(loaded?.afterToolCallIds).toEqual(['call_servertool_fallback_1777378574502_510']);

    const pendingFile = path.join(sessionDir, 'servertool-pending', 'sess-synthetic.json');
    expect(fs.existsSync(pendingFile)).toBe(true);
  });
});
