import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildContentPartDeltas } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.js';
import { StringUtils } from '../../sharedmodule/llmswitch-core/src/sse/shared/utils.js';
import type { ResponsesEventGeneratorContext } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.js';

describe('responses SSE chunking no-fallback boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the native chunking owner instead of falling back to the retired TS chunker', async () => {
    const chunkStringSpy = jest
      .spyOn(StringUtils, 'chunkString')
      .mockImplementation(() => {
        throw new Error('retired TS chunker must not be called');
      });

    const context: ResponsesEventGeneratorContext = {
      requestId: 'req_responses_chunk_no_fallback',
      model: 'gpt-5.5',
      outputIndexCounter: 0,
      contentIndexCounter: new Map(),
      sequenceCounter: 0
    };

    const generator = buildContentPartDeltas(
      'item_1',
      0,
      'hello world',
      context,
      { chunkSize: 8, enableIdGeneration: true, enableTimestampGeneration: false, enableSequenceNumbers: false }
    );

    const deltas = [];
    for await (const event of generator) {
      deltas.push(event);
    }

    expect(chunkStringSpy).not.toHaveBeenCalled();
    expect(deltas.map((event) => (event.data as { delta?: unknown }).delta)).toEqual([
      'hello ',
      'world'
    ]);
  });
});
