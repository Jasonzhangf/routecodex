import { describe, expect, it } from '@jest/globals';

import { ResponsesEventSerializer } from '../../sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.js';

describe('responses event serializer no-salvage boundary', () => {
  it('throws on invalid JSON data instead of returning the raw payload string', () => {
    const serializer = new ResponsesEventSerializer();

    expect(() => serializer.deserializeFromWire(
      'event: response.done\n' +
      'data: not-json\n'
    )).toThrow('Invalid Responses SSE data payload: not-json');
  });
});
