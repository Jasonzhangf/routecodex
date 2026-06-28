import { buildRequestMetadata } from '../../../../src/server/runtime/http-server/executor-metadata.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

describe('buildRequestMetadata portScope write-once binding', () => {
  it('reuses an existing same-value MetadataCenter portScope during relay metadata rebuild', () => {
    const metadata: Record<string, unknown> = {
      portContext: { entryPort: 5555 }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'portScope',
      '5555',
      {
        module: 'tests/server/runtime/http-server/executor-metadata.port-scope.spec.ts',
        symbol: 'reuses an existing same-value MetadataCenter portScope during relay metadata rebuild',
        stage: 'ServerReqInbound01ClientRaw'
      },
      'pre-bound relay port scope'
    );

    const result = buildRequestMetadata({
      body: {},
      headers: {},
      metadata,
      entryEndpoint: '/v1/responses'
    } as any);

    expect(result.portScope).toBe('5555');
    expect(MetadataCenter.read(result)?.readRequestTruth().portScope).toBe('5555');
  });

  it('fails fast when a bound MetadataCenter portScope conflicts with the incoming port', () => {
    const metadata: Record<string, unknown> = {
      portContext: { entryPort: 5555 }
    };
    MetadataCenter.attach(metadata).writeRequestTruth(
      'portScope',
      '5520',
      {
        module: 'tests/server/runtime/http-server/executor-metadata.port-scope.spec.ts',
        symbol: 'fails fast when a bound MetadataCenter portScope conflicts with the incoming port',
        stage: 'ServerReqInbound01ClientRaw'
      },
      'conflicting relay port scope'
    );

    expect(() => buildRequestMetadata({
      body: {},
      headers: {},
      metadata,
      entryEndpoint: '/v1/responses'
    } as any)).toThrow('MetadataCenter request_truth.portScope conflict: existing=5520 incoming=5555');
  });
});
