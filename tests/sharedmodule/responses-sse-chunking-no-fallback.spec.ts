import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildContentPartDeltas } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.js';
import { StringUtils } from '../../sharedmodule/llmswitch-core/src/sse/shared/utils.js';
import type { ResponsesEventGeneratorContext } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.js';

describe('responses SSE chunking no-fallback boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('surfaces chunking errors instead of falling back to the original text', async () => {
    const chunkStringSpy = jest
      .spyOn(StringUtils, 'chunkString')
      .mockImplementation(() => {
        throw new Error('chunking failed');
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
      { chunkSize: 8, chunkDelayMs: 0, enableIdGeneration: true, enableTimestampGeneration: false, enableSequenceNumbers: false, enableDelay: false }
    );

    await expect((async () => {
      for await (const _event of generator) {
        void _event;
      }
    })()).rejects.toThrow('chunking failed');

    expect(chunkStringSpy).toHaveBeenCalledTimes(1);
  });
});
