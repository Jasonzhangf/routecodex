/**
* Phase Server-C red test: client JSON/SSE response must not contain
* internal carrier fields; violations must fail-fast (no silent delete).
*/

import {
  assertClientResponseHasNoInternalCarriers
} from '../../src/server/handlers/handler-response-utils.js';

describe('server.response_projection internal carrier guard (Phase Server-C)', () => {
  const FORBIDDEN = [
    'metaCarrier', 'runtimeMetadata',
    'errorCarrier', 'classifiedError', '__rt', 'snapshot', 'snapshotId',
    '__raw_request_body', 'internalDetails', 'upstreamRequestId', 'providerStack'
  ];

  for (const field of FORBIDDEN) {
    it(`fails fast when top-level response body contains "${field}"`, () => {
      expect(() => assertClientResponseHasNoInternalCarriers(
        { id: 'x', [field]: 'oops' },
        'req-1'
      )).toThrow(`[server.response_projection] client response contains internal carrier field "${field}"`);
    });
  }

  it('fails fast on nested forbidden field (deep object)', () => {
    expect(() => assertClientResponseHasNoInternalCarriers(
      { id: 'x', choices: [{ message: { __rt: 'oops' } }] },
      'req-1'
    )).toThrow('__rt');
  });

  it('passes on clean response body', () => {
    expect(() => assertClientResponseHasNoInternalCarriers(
      { id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }] },
      'req-1'
    )).not.toThrow();
  });

  it('passes legal client-visible protocol metadata', () => {
    expect(() => assertClientResponseHasNoInternalCarriers(
      { id: 'resp_1', object: 'response', metadata: { user_tag: 'safe' } },
      'req-1'
    )).not.toThrow();
  });

  it('fails fast when non-Responses JSON body carries top-level metadata even if values look client-safe', () => {
    expect(() => assertClientResponseHasNoInternalCarriers(
      { id: 'chatcmpl_1', object: 'chat.completion', metadata: { user_tag: 'safe' } },
      'req-1'
    )).toThrow('metadata');
  });

  it('fails fast when metadata carries internal routing controls', () => {
    expect(() => assertClientResponseHasNoInternalCarriers(
      { id: 'resp_1', object: 'response', metadata: { routeHint: 'tools' } },
      'req-1'
    )).toThrow('metadata');
  });

  it('handles cycles without infinite loop and still detects forbidden field', () => {
    const a: any = { id: 'x' };
    a.self = a;
    a.__rt = 'oops';
    expect(() => assertClientResponseHasNoInternalCarriers(a, 'req-1')).toThrow('__rt');
  });
});
