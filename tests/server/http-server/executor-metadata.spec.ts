import { describe, expect, it } from '@jest/globals';

import { buildRequestMetadata } from '../../../src/server/runtime/http-server/executor-metadata.js';
import { encodeClockClientApiKey } from '../../../src/utils/clock-client-token.js';

describe('executor metadata clock daemon extraction', () => {
  it('extracts clockDaemonId from apikey bearer suffix', () => {
    const apiKey = encodeClockClientApiKey('sk-base', 'clockd_meta_1');
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-1',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'codex'
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_1' }
    } as any);

    expect(metadata.clockDaemonId).toBe('clockd_meta_1');
    expect(metadata.sessionId).toBe('conv_meta_1');
  });

  it('prefers explicit daemon header when present', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-2',
      headers: {
        'x-routecodex-clock-daemon-id': 'clockd_header_1',
        authorization: `Bearer ${encodeClockClientApiKey('sk-base', 'clockd_other')}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_2' }
    } as any);

    expect(metadata.clockDaemonId).toBe('clockd_header_1');
  });
});
