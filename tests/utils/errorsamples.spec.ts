import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  __flushErrorsampleQueueForTests,
  __resetErrorsampleQueueForTests,
  writeErrorsampleJson
} from '../../src/utils/errorsamples.js';

const ENV_KEYS = [
  'RCC_ERRORSAMPLES_DIR',
  'ROUTECODEX_ERRORSAMPLES_DIR',
  'ROUTECODEX_ERRORSAMPLE_MAX_BYTES',
  'RCC_ERRORSAMPLE_MAX_BYTES',
  'ROUTECODEX_ERRORSAMPLE_MAX_FILES_PER_GROUP',
  'RCC_ERRORSAMPLE_MAX_FILES_PER_GROUP',
  'ROUTECODEX_ERRORSAMPLE_MAX_BYTES_PER_GROUP',
  'RCC_ERRORSAMPLE_MAX_BYTES_PER_GROUP',
  'ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES',
  'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES',
  'ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES',
  'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES',
  'ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES',
  'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES',
  'ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS',
  'RCC_ERRORSAMPLE_PRUNE_INTERVAL_MS',
  'ROUTECODEX_ERRORSAMPLE_QUEUE_MAX_ITEMS',
  'RCC_ERRORSAMPLE_QUEUE_MAX_ITEMS',
  'ROUTECODEX_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES',
  'RCC_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES'
] as const;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe('errorsample writer safeguards', () => {
  it('truncates oversized payload before writing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-truncate-'));
    const envBackup = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }
    try {
      process.env.RCC_ERRORSAMPLES_DIR = tmp;
      process.env.ROUTECODEX_ERRORSAMPLE_MAX_BYTES = '1024';
      process.env.ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES = '1024';
      process.env.ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS = '0';

      const file = await writeErrorsampleJson({
        group: 'client-tool-error',
        kind: 'chat_process.req.stage2.semantic_map.exec_command',
        payload: { text: 'x'.repeat(40_000) }
      });
      await __flushErrorsampleQueueForTests();
      const text = await fs.readFile(file, 'utf8');
      const json = JSON.parse(text) as Record<string, unknown>;

      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024);
      expect(json.truncated).toBe(true);
      expect(typeof json.reason).toBe('string');
    } finally {
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      __resetErrorsampleQueueForTests();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('prunes old client-tool-error samples by per-group file budget', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-prune-'));
    const envBackup = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }
    try {
      process.env.RCC_ERRORSAMPLES_DIR = tmp;
      process.env.ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES = '3';
      process.env.ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES = '8192';
      process.env.ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS = '0';

      for (let i = 0; i < 8; i += 1) {
        await writeErrorsampleJson({
          group: 'client-tool-error',
          kind: `chat_process.req.stage2.semantic_map.exec_command.${i}`,
          payload: { i, msg: `sample-${i}` }
        });
      }
      await __flushErrorsampleQueueForTests();

      const groupDir = path.join(tmp, 'client-tool-error');
      const files = await listFiles(groupDir);
      expect(files.length).toBeLessThanOrEqual(3);
    } finally {
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      __resetErrorsampleQueueForTests();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps only the newest 50 generic errorsamples by default', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-default-prune-'));
    const envBackup = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }
    try {
      process.env.RCC_ERRORSAMPLES_DIR = tmp;
      process.env.ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS = '0';
      delete process.env.ROUTECODEX_ERRORSAMPLE_MAX_FILES_PER_GROUP;
      delete process.env.RCC_ERRORSAMPLE_MAX_FILES_PER_GROUP;

      for (let i = 0; i < 55; i += 1) {
        await writeErrorsampleJson({
          group: 'provider-error',
          kind: `provider-error.${i}`,
          payload: { i, msg: `sample-${i}` }
        });
      }
      await __flushErrorsampleQueueForTests();

      const groupDir = path.join(tmp, 'provider-error');
      const files = await listFiles(groupDir);
      expect(files.length).toBeLessThanOrEqual(50);
    } finally {
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      __resetErrorsampleQueueForTests();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('redacts obvious secret fields before persisting sample payload', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-redact-'));
    const envBackup = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }
    try {
      process.env.RCC_ERRORSAMPLES_DIR = tmp;
      process.env.ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS = '0';

      const file = await writeErrorsampleJson({
        group: 'client-tool-error',
        kind: 'chat_process.req.stage2.semantic_map.exec_command.redact',
        payload: {
          apiKey: 'sk-user-aaaaaaaaaaaaaaaaaaaaaaaa',
          headers: {
            Authorization: 'Bearer abcdefghijklmnop'
          },
          note: 'api_key=raw-secret-key-value'
        }
      });
      await __flushErrorsampleQueueForTests();

      const text = await fs.readFile(file, 'utf8');
      expect(text).not.toContain('raw-secret-key-value');
      expect(text).not.toContain('Bearer abcdefghijklmnop');
      expect(text).not.toContain('sk-user-aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(text).toContain('[REDACTED]');
    } finally {
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      __resetErrorsampleQueueForTests();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('skips transient 429/502 errorsamples', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-skip-transient-'));
    const envBackup = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }
    try {
      process.env.RCC_ERRORSAMPLES_DIR = tmp;
      process.env.ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS = '0';

      const first = await writeErrorsampleJson({
        group: 'provider-error',
        kind: 'provider-error.429',
        payload: {
          statusCode: 429,
          error: { message: 'rate limited' }
        }
      });
      const second = await writeErrorsampleJson({
        group: 'provider-error',
        kind: 'provider-error.502',
        payload: {
          error: { status: 502, message: 'bad gateway' }
        }
      });

      expect(first).toBeNull();
      expect(second).toBeNull();
      const files = await listFiles(path.join(tmp, 'provider-error'));
      expect(files).toHaveLength(0);
    } finally {
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      __resetErrorsampleQueueForTests();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('drops oldest pending errorsamples when the queue is full', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-queue-'));
    const envBackup = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      envBackup.set(key, process.env[key]);
    }
    try {
      process.env.RCC_ERRORSAMPLES_DIR = tmp;
      process.env.ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS = '0';
      process.env.ROUTECODEX_ERRORSAMPLE_QUEUE_MAX_ITEMS = '2';
      process.env.ROUTECODEX_ERRORSAMPLE_QUEUE_MEMORY_BUDGET_BYTES = '1048576';

      const p1 = writeErrorsampleJson({
        group: 'provider-error',
        kind: 'provider-error.1',
        payload: { seq: 1 }
      });
      const p2 = writeErrorsampleJson({
        group: 'provider-error',
        kind: 'provider-error.2',
        payload: { seq: 2 }
      });
      const p3 = writeErrorsampleJson({
        group: 'provider-error',
        kind: 'provider-error.3',
        payload: { seq: 3 }
      });
      const p4 = writeErrorsampleJson({
        group: 'provider-error',
        kind: 'provider-error.4',
        payload: { seq: 4 }
      });

      const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
      await __flushErrorsampleQueueForTests();

      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(typeof r3).toBe('string');
      expect(typeof r4).toBe('string');
      const files = await listFiles(path.join(tmp, 'provider-error'));
      expect(files).toHaveLength(2);
    } finally {
      for (const key of ENV_KEYS) {
        const value = envBackup.get(key);
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(tmp, { recursive: true, force: true });
      __resetErrorsampleQueueForTests();
    }
  });
});
