import fs from 'node:fs';
import path from 'node:path';

import {
  buildHandlerPipelineMetadata,
  readRequestBodyMetadata,
} from '../../../src/server/handlers/handler-utils.js';

describe('handler request-body metadata copy budget', () => {
  it('borrows request metadata instead of serializing a deep copy before whitelist projection', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/server/handlers/handler-utils.ts'),
      'utf8',
    );
    const block = source.match(
      /export function readRequestBodyMetadata[\s\S]*?\n}\n\nexport function stripRequestBodyMetadataForPipeline/,
    )?.[0];

    expect(block).toBeDefined();
    expect(block).not.toContain('JSON.stringify');
    expect(block).not.toContain('JSON.parse');

    const metadata = {
      clientRequestId: 'client-copy-budget',
      sessionId: 'session-copy-budget',
    };
    expect(readRequestBodyMetadata({ metadata })).toBe(metadata);
  });

  it('keeps the whitelist projection independent without mutating borrowed request metadata', () => {
    const metadata = {
      clientRequestId: 'client-copy-budget',
      sessionId: 'session-copy-budget',
    };
    const borrowed = readRequestBodyMetadata({ metadata });
    const projected = buildHandlerPipelineMetadata(borrowed, { requestId: 'request-copy-budget' });

    expect(projected).toMatchObject({
      clientRequestId: 'client-copy-budget',
      sessionId: 'session-copy-budget',
      requestId: 'request-copy-budget',
    });
    expect(projected).not.toBe(metadata);
    expect(metadata).toEqual({
      clientRequestId: 'client-copy-budget',
      sessionId: 'session-copy-budget',
    });
  });
});
