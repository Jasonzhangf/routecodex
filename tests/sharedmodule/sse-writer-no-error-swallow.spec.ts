import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { createResponsesStreamWriter } from '../../sharedmodule/llmswitch-core/src/sse/shared/writer.js';

describe('SSE writer no error swallow boundary', () => {
  it('rejects unsupported Responses events instead of only reporting onError', async () => {
    const onError = jest.fn();
    const stream = new PassThrough();
    const writer = createResponsesStreamWriter(stream, { onError });

    await expect(writer.writeResponsesEvents([
      {
        type: 'not.response',
        protocol: 'responses',
        direction: 'json_to_sse',
        timestamp: 1,
        data: {},
        sequenceNumber: 0
      } as any
    ])).rejects.toThrow('Unsupported ResponsesSseEvent type: not.response');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(writer.getStats().errors).toBe(1);
  });

  it('does not keep dead queue state or timeout config in the shared writer', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/shared/writer.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('private writeQueue');
    expect(source).not.toContain('private isWriting');
    expect(source).not.toContain('timeoutMs?:');
    expect(source).not.toContain('timeoutMs: config.timeoutMs');
  });
});
