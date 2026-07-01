import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServerColoredLogger } from '../../../../src/server/runtime/http-server/colored-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.resolve(__dirname, '../../../../src/server/runtime/http-server/colored-logger.ts');

describe('http server colored logger', () => {
  it('does not keep dummy/no-op fallback logger paths', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('createRequire');
    expect(source).not.toContain('localRequire');
    expect(source).not.toContain('Fallback');
    expect(source).not.toContain('dummy logger');
    expect(source).not.toContain('no-op logger');
    expect(source).not.toContain('log: () => {}');
  });

  it('returns the real colored logger in test runtime', () => {
    const logger = createServerColoredLogger();

    expect(typeof logger.logProviderRequest).toBe('function');
    expect(typeof logger.logModule).toBe('function');
    expect(typeof logger.logVirtualRouterHit).toBe('function');
  });
});
