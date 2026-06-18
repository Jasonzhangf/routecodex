import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const FOLLOWUP_DISPATCH_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts'
);

function countMatches(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('servertool followup dispatch contract', () => {
  it('keeps requestSemantics routecodex residue localized to the followup materializer helper band', () => {
    const source = fs.readFileSync(FOLLOWUP_DISPATCH_PATH, 'utf8');
    const residueBand = sliceBetween(
      source,
      `function ${'isServerToolFollowup'}`,
      `function ${'stripResponsesOnlyRequestSettings'}`
    );
    const afterBand = source.slice(source.indexOf(`function ${'stripResponsesOnlyRequestSettings'}`));

    expect(countMatches(source, '__routecodex')).toBe(18);
    expect(countMatches(residueBand, '__routecodex')).toBe(18);
    expect(afterBand).not.toContain('__routecodex');
    expect(residueBand).not.toContain('metadata?.__routecodex');
  });

  it('materializes followup routecodex semantics only through the cloned nextSemantics helper path', () => {
    const source = fs.readFileSync(FOLLOWUP_DISPATCH_PATH, 'utf8');
    const materializeBlock = sliceBetween(
      source,
      `function ${'materializeFollowupRequestSemantics'}`,
      `function ${'stripResponsesOnlyRequestSettings'}`
    );

    expect(materializeBlock).toContain(
      "delete routecodex.serverToolFollowup;"
    );
    expect(materializeBlock).toContain(
      "delete routecodex.serverToolFollowupSource;"
    );
    expect(materializeBlock).toContain(
      "nextSemantics.__routecodex = {"
    );
    expect(materializeBlock).toContain(
      "stoplessGoalStatus: 'active'"
    );
  });
});
