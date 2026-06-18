import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const PROVIDER_RESPONSE_CONVERTER_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/executor/provider-response-converter.ts'
);

function countMatches(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

describe('provider-response-converter contract', () => {
  it('keeps remaining routecodex residue as a single pure request-semantics read', () => {
    const source = fs.readFileSync(PROVIDER_RESPONSE_CONVERTER_PATH, 'utf8');

    expect(countMatches(source, '__routecodex')).toBe(1);
    expect(source).toContain(
      'const routecodexSemantics = asFlatRecord(options.requestSemantics?.__routecodex);'
    );
    expect(source).toContain(
      "const isServerToolFollowupRequest = routecodexSemantics?.serverToolFollowup === true;"
    );
    expect(source).not.toContain('__routecodex =');
    expect(source).not.toContain('metadata?.__routecodex');
    expect(source).not.toContain('response.metadata');
    expect(source).not.toContain('seed.metadata');
  });
});
