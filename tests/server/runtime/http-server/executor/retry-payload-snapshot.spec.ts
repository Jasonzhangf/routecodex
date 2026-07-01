import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const retryPayloadSnapshotSourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/retry-payload-snapshot.ts'
);

describe('retry payload snapshot cleanup', () => {
  it('does not keep unused fallback payload restore path', () => {
    const source = fs.readFileSync(retryPayloadSnapshotSourcePath, 'utf8');

    expect(source).not.toContain('fallbackPayload');
  });
});
