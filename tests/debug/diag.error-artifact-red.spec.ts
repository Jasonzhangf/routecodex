import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDebugErrorDiagArtifactRecord,
  readDebugErrorDiagArtifact,
  writeDebugErrorDiagArtifact,
} from '../../src/debug/diag/index.js';

describe('debug diag error artifact M1', () => {
  it('writes redacted error artifacts under the debug diag root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-debug-diag-'));
    const filePath = await writeDebugErrorDiagArtifact({
      endpoint: '/v1/responses',
      requestId: 'req/unsafe:1',
      requestBody: {
        model: 'gpt-5.5',
        metadata: { authorization: 'Bearer super-secret-token' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      error: Object.assign(new Error('boom'), {
        code: 'E_TEST',
        statusCode: 502,
        details: { api_key: 'placeholder-test-key' },
      }),
      rootDir: dir,
    });

    expect(filePath.startsWith(dir)).toBe(true);
    expect(path.basename(filePath)).toBe('error-req_unsafe_1.json');

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('"requestId": "req/unsafe:1"');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('placeholder-test-key');

    const parsed = await readDebugErrorDiagArtifact(filePath);
    expect(parsed.endpoint).toBe('/v1/responses');
    expect(parsed.code).toBe('E_TEST');
    expect(parsed.statusCode).toBe(502);
    expect(JSON.stringify(parsed.requestBody)).toContain('[REDACTED]');
    expect(JSON.stringify(parsed.details)).toContain('[REDACTED]');
  });

  it('builds a stable record shape for handler-side write calls', () => {
    const record = buildDebugErrorDiagArtifactRecord({
      endpoint: '/v1/responses.submit_tool_outputs',
      requestId: 'req-1',
      requestBody: { input: [], authorization: 'Bearer another-secret' },
      error: Object.assign(new Error('handler failed'), {
        code: 'HTTP_HANDLER_ERROR',
        status: 500,
      }),
      timestamp: '2026-06-22T00:00:00.000Z',
    });

    expect(record).toEqual(expect.objectContaining({
      endpoint: '/v1/responses.submit_tool_outputs',
      requestId: 'req-1',
      message: 'handler failed',
      code: 'HTTP_HANDLER_ERROR',
      status: 500,
      timestamp: '2026-06-22T00:00:00.000Z',
    }));
    expect(JSON.stringify(record.requestBody)).not.toContain('another-secret');
  });
});
