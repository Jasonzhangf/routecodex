import {
  mergePipelineMetadata,
  __pipelineMetadataAllowedClientFields,
  __pipelineMetadataDeniedClientFields
} from '../../../src/server/handlers/handler-utils.js';

describe('handler-utils server.req_adapter metadata contract', () => {
  it('allows explicit client identity metadata fields only', () => {
    const merged = mergePipelineMetadata(
      {
        clientRequestId: 'client-1',
        userAgent: 'ua',
        clientOriginator: 'originator'
      },
      {
        requestId: 'req-1',
        providerProtocol: 'openai-chat'
      }
    );
    expect(merged).toMatchObject({
      clientRequestId: 'client-1',
      userAgent: 'ua',
      clientOriginator: 'originator',
      requestId: 'req-1',
      providerProtocol: 'openai-chat'
    });
  });

  it('fails fast on route/provider/runtime control metadata', () => {
    for (const field of ['routeHint', '__rt', 'providerKey', 'metaCarrier', 'errorCarrier']) {
      expect(() => mergePipelineMetadata({ [field]: 'x' }, { requestId: 'req-1' })).toThrow(
        `[server.req_adapter] forbidden client metadata field: ${field}`
      );
    }
  });

  it('fails fast on unknown client metadata fields', () => {
    expect(() => mergePipelineMetadata({ arbitrary: 'x' }, { requestId: 'req-1' })).toThrow(
      '[server.req_adapter] unsupported client metadata field: arbitrary'
    );
  });

  it('contract helper lists expose allowed and denied field sets for tests/help sync', () => {
    expect(__pipelineMetadataAllowedClientFields().has('clientRequestId')).toBe(true);
    expect(__pipelineMetadataDeniedClientFields().has('routeHint')).toBe(true);
  });
});
