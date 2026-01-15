import { describe, expect, test } from '@jest/globals';
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
});

