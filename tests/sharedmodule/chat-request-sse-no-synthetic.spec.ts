import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';

import { ChatJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.js';

describe('chat request SSE no synthetic response boundary', () => {
  it('does not expose request-to-SSE conversion that fabricates chat response chunks', () => {
    const converter = new ChatJsonToSseConverterRefactored();

    expect((converter as any).convertRequestToJsonToSse).toBeUndefined();
  });

  it('does not keep a request sequencer that emits response SSE chunks from request messages', () => {
    const converterSource = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.ts',
      'utf8'
    );
    const sequencerSource = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/chat-sequencer.ts',
      'utf8'
    );

    expect(converterSource).not.toContain('convertRequestToJsonToSse(');
    expect(converterSource).not.toContain('processRequestToSseWithFunctions');
    expect(sequencerSource).not.toContain('sequenceChatRequest(');
    expect(sequencerSource).not.toContain('sequenceRequest(request');
  });
});
