import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

let clearPendingServerToolInjection: typeof import('../../sharedmodule/llmswitch-core/src/servertool/pending-session.js').clearPendingServerToolInjection;
let loadPendingServerToolInjection: typeof import('../../sharedmodule/llmswitch-core/src/servertool/pending-session.js').loadPendingServerToolInjection;
let savePendingServerToolInjection: typeof import('../../sharedmodule/llmswitch-core/src/servertool/pending-session.js').savePendingServerToolInjection;

function nativePath(): string {
  return path.join(
    process.cwd(),
    'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node'
  );
}

describe('servertool pending-session', () => {
  let sessionDir = '';
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const originalNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  beforeAll(async () => {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = nativePath();
    ({
      clearPendingServerToolInjection,
      loadPendingServerToolInjection,
      savePendingServerToolInjection
    } = await import('../../sharedmodule/llmswitch-core/src/servertool/pending-session.js'));
  });

  afterAll(() => {
    if (originalNativePath === undefined) delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    else process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = originalNativePath;
  });

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-pending-session-'));
    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
  });

  afterEach(async () => {
    process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    await clearPendingServerToolInjection('sess-valid', sessionDir);
    await clearPendingServerToolInjection('sess-synthetic', sessionDir);
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
    }, sessionDir);

    const loaded = await loadPendingServerToolInjection('sess-valid', sessionDir);
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
    }, sessionDir);

    const loaded = await loadPendingServerToolInjection('sess-synthetic', sessionDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.afterToolCallIds).toEqual(['call_servertool_fallback_1777378574502_510']);

    const pendingFile = path.join(sessionDir, 'servertool-pending', 'sess-synthetic.json');
    expect(fs.existsSync(pendingFile)).toBe(true);
  });
});
