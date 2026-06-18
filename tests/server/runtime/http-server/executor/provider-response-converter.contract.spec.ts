import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  buildResponseMetadataBagForProviderResponseConverter
} from '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js';

const ROOT = process.cwd();
const PROVIDER_RESPONSE_CONVERTER_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/executor/provider-response-converter.ts'
);

function countMatches(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

describe('provider-response-converter contract', () => {
  it('does not read followup control from requestSemantics routecodex residue', () => {
    const source = fs.readFileSync(PROVIDER_RESPONSE_CONVERTER_PATH, 'utf8');

    expect(countMatches(source, '__routecodex')).toBe(0);
    expect(source).not.toContain('options.requestSemantics?.__routecodex');
    expect(source).not.toContain('__routecodex =');
    expect(source).not.toContain('metadata?.__routecodex');
    expect(source).not.toContain('response.metadata');
    expect(source).not.toContain('seed.metadata');
    expect(source).toContain('MetadataCenter.read(metadata)?.readRuntimeControl()');
    expect(source).not.toContain('adapterRt?.stoplessGoalStatus');
    expect(source).toContain("MetadataCenter.attach(args.adapterContext).writeRuntimeControl(");
    expect(source).toContain("'stoplessGoalStatus'");
  });

  it('preserves MetadataCenter when adding providerFamily to response metadata', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'stopMessageEnabled',
      true,
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts',
        symbol: 'preserves MetadataCenter when adding providerFamily to response metadata',
        stage: 'test'
      }
    );

    const responseMetadata = buildResponseMetadataBagForProviderResponseConverter({
      metadata,
      providerFamily: 'MiniMax'
    });

    expect(responseMetadata).not.toBe(metadata);
    expect(responseMetadata.providerFamily).toBe('MiniMax');
    expect(MetadataCenter.read(responseMetadata)).toBe(center);
    expect(MetadataCenter.read(responseMetadata)?.readRuntimeControl().stopMessageEnabled).toBe(true);
  });
});
