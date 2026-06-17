import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import type { ServerSideToolEngineResult } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';

let persistPendingServerToolInjection: typeof import(
  '../../sharedmodule/llmswitch-core/src/servertool/pending-injection-block.js'
).persistPendingServerToolInjection;

function nativePath(): string {
  return path.join(
    process.cwd(),
    'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node'
  );
}

function buildPendingInjection(): NonNullable<ServerSideToolEngineResult['pendingInjection']> {
  return {
    sessionId: ' sess-1 ',
    aliasSessionIds: ['sess-2', ' sess-1 ', ''],
    afterToolCallIds: ['call-client-1'],
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-servertool-1',
            type: 'function',
            function: { name: 'clock', arguments: '{}' }
          }
        ]
      }
    ]
  };
}

async function readPendingFile(root: string, sessionId: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(root, 'servertool-pending', `${sessionId}.json`), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('pending-injection-block native shell', () => {
  const previousSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const previousNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  let tempRoot = '';

  beforeAll(async () => {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = nativePath();
    ({ persistPendingServerToolInjection } = await import(
      '../../sharedmodule/llmswitch-core/src/servertool/pending-injection-block.js'
    ));
  });

  afterAll(() => {
    if (previousNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = previousNativePath;
    }
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-pending-injection-'));
    process.env.ROUTECODEX_SESSION_DIR = tempRoot;
  });

  afterEach(async () => {
    if (previousSessionDir === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = previousSessionDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('persists native planned records for unique sessions', async () => {
    await expect(
      persistPendingServerToolInjection({
        pendingInjection: buildPendingInjection(),
        requestId: ' req-1 ',
        flowId: ' flow-1 ',
        adapterContext: {
          __rt: {
            sessionDir: tempRoot
          }
        }
      })
    ).resolves.toBe(true);

    const first = await readPendingFile(tempRoot, 'sess-1');
    const second = await readPendingFile(tempRoot, 'sess-2');
    expect(first).toMatchObject({
      sessionId: 'sess-1',
      afterToolCallIds: ['call-client-1'],
      sourceRequestId: 'req-1'
    });
    expect(second).toMatchObject({
      sessionId: 'sess-2',
      afterToolCallIds: ['call-client-1'],
      sourceRequestId: 'req-1'
    });
  });

  test('returns false when native plan skips empty session targets', async () => {
    await expect(
      persistPendingServerToolInjection({
        pendingInjection: {
          ...buildPendingInjection(),
          sessionId: ' ',
          aliasSessionIds: ['']
        },
        requestId: 'req-2',
        flowId: 'flow-2',
        adapterContext: {
          __rt: {
            sessionDir: tempRoot
          }
        }
      })
    ).resolves.toBe(false);

    await expect(fs.access(path.join(tempRoot, 'servertool-pending'))).rejects.toBeTruthy();
  });

  test('throws native planned persistence error envelope on save failure', async () => {
    await fs.writeFile(path.join(tempRoot, 'servertool-pending'), 'not-a-directory', 'utf8');

    await expect(
      persistPendingServerToolInjection({
        pendingInjection: buildPendingInjection(),
        requestId: 'req-3',
        flowId: 'flow-3',
        adapterContext: {
          __rt: {
            sessionDir: tempRoot
          }
        }
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_PENDING_INJECTION_FAILED',
      category: 'INTERNAL_ERROR',
      status: 502,
      details: {
        requestId: 'req-3',
        flowId: 'flow-3',
        sessionIds: ['sess-1', 'sess-2']
      }
    });
  });
});
