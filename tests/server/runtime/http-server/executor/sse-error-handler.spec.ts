import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSseWrapperError } from '../../../../../src/server/runtime/http-server/executor/sse-error-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sseErrorHandlerSourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/sse-error-handler.ts'
);

describe('sse error handler fallback cleanup', () => {
  it('does not keep malformed JSON raw-string fallback projection', () => {
    const source = fs.readFileSync(sseErrorHandlerSourcePath, 'utf8');

    expect(source).not.toContain('fallback to raw string');
  });

  it('does not salvage JSON-looking malformed SSE error strings as upstream errors', () => {
    expect(extractSseWrapperError({
      mode: 'sse',
      error: '{"message":'
    })).toBeUndefined();
  });
});
