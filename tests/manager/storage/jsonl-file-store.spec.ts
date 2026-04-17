import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { JsonlFileStore } from '../../../src/manager/storage/file-store.js';

describe('JsonlFileStore', () => {
  it('treats missing file as empty state without warning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-jsonl-store-'));
    const filePath = path.join(tempDir, 'missing.jsonl');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new JsonlFileStore<{ ok: boolean }>({ filePath });
      await expect(store.load()).resolves.toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('still warns on non-ENOENT read failures', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-jsonl-store-'));
    const dirPath = path.join(tempDir, 'as-dir');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fs.mkdir(dirPath, { recursive: true });
      const store = new JsonlFileStore<{ ok: boolean }>({ filePath: dirPath });
      await expect(store.load()).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('load.readFile failed');
    } finally {
      warnSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('treats missing file compact as no-op without warning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-jsonl-store-'));
    const filePath = path.join(tempDir, 'missing.jsonl');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new JsonlFileStore<{ ok: boolean }>({ filePath });
      await expect(store.compact()).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
