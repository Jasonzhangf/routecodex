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
  it('does not materialize followup control through requestSemantics routecodex residue', () => {
    const source = fs.readFileSync(FOLLOWUP_DISPATCH_PATH, 'utf8');

    expect(countMatches(source, '__routecodex')).toBe(0);
    expect(source).not.toContain('requestSemantics?.__routecodex');
    expect(source).not.toContain('nextSemantics.__routecodex');
    expect(source).not.toContain('metadata?.__routecodex');
  });

  it('materializes followup control through MetadataCenter/runtime side-channel only', () => {
    const source = fs.readFileSync(FOLLOWUP_DISPATCH_PATH, 'utf8');
    const materializeBlock = sliceBetween(
      source,
      `function ${'materializeFollowupRequestSemantics'}`,
      `function ${'stripResponsesOnlyRequestSettings'}`
    );

    expect(materializeBlock).toContain('readFollowupMarkerFromMetadata(args.metadata)');
    expect(materializeBlock).toContain('readFollowupMarkerFromMetadata(args.baseMetadata)');
    expect(materializeBlock).not.toContain('__routecodex');
    expect(source).toContain('MetadataCenter.attach(metadata).writeRuntimeControl');
  });

  it('does not write stopMessage enablement into flat metadata or __rt fallback control', () => {
    const source = fs.readFileSync(FOLLOWUP_DISPATCH_PATH, 'utf8');
    const nestedBuilderBlock = sliceBetween(
      source,
      `async function ${'buildServerToolNestedInput'}`,
      `export async function ${'executeServerToolReenterPipeline'}`
    );

    expect(nestedBuilderBlock).not.toContain('nestedRuntime.stopMessageEnabled');
    expect(nestedBuilderBlock).not.toContain('nestedMetadata.stopMessageEnabled');
    expect(nestedBuilderBlock).not.toContain('nestedMetadata.routecodexPortStopMessageEnabled');
    expect(nestedBuilderBlock).not.toContain('stopMessageEnabled: false');
    expect(nestedBuilderBlock).not.toContain('routecodexPortStopMessageEnabled: false');
    expect(nestedBuilderBlock).toContain('readRuntimeControlProjection(nestedMetadata)');
    expect(nestedBuilderBlock).toContain('writeStopMessageEnabledRuntimeControl(');
    expect(source).toContain("'stopMessageEnabled'");
    expect(source).toContain('writeRuntimeControl(');
  });
});
