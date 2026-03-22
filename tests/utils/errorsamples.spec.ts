import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { writeErrorsampleJson } from '../../src/utils/errorsamples.js';

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
  'RCC_ERRORSAMPLE_PRUNE_INTERVAL_MS'
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
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
