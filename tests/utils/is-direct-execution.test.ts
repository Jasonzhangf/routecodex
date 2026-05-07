import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { isDirectExecution } from '../../src/utils/is-direct-execution.js';

describe('isDirectExecution', () => {
  test('matches resolved argv1 path URL', () => {
    const argv1 = path.resolve('dist/index.js');
    const metaUrl = pathToFileURL(argv1).href;
    expect(isDirectExecution(metaUrl, argv1)).toBe(true);
  });

  test('matches when argv1 is relative', () => {
    const argv1Abs = path.resolve('dist/index.js');
    const argv1Rel = path.relative(process.cwd(), argv1Abs) || 'dist/index.js';
    const metaUrl = pathToFileURL(argv1Abs).href;
    expect(isDirectExecution(metaUrl, argv1Rel)).toBe(true);
  });

  test('returns false for different script', () => {
    const argv1 = path.resolve('dist/index.js');
    const other = path.resolve('dist/other.js');
    const metaUrl = pathToFileURL(other).href;
    expect(isDirectExecution(metaUrl, argv1)).toBe(false);
  });

  test('matches symlink argv1 against realpath import meta url', () => {
    const baseDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-is-direct-'));
    const realDir = path.join(baseDir, 'real');
    const linkDir = path.join(baseDir, 'current');
    fs.mkdirSync(realDir, { recursive: true });
    const realFile = path.join(realDir, 'index.js');
    fs.writeFileSync(realFile, 'export {};', 'utf8');
    fs.symlinkSync(realDir, linkDir);

    const argv1 = path.join(linkDir, 'index.js');
    const metaUrl = pathToFileURL(realFile).href;
    expect(isDirectExecution(metaUrl, argv1)).toBe(true);
  });
});
