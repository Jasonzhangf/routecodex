import { describe, expect, it } from '@jest/globals';
import { assembleSseEvent } from '../../src/sse/sse-to-json/parsers/sse-parser.js';

describe('sse parser native assemble', () => {
  it('assembles multi-line data event', () => {
    const output = assembleSseEvent([
      'event: response.output_text.delta',
      'id: 7',
      'data: {"delta":"hello"}',
      'data: {"delta":" world"}',
      'retry: 1200',
      'timestamp: 1730000000'
    ]);
    expect(output).toEqual({
      event: 'response.output_text.delta',
      id: '7',
      data: '{"delta":"hello"}\n{"delta":" world"}',
      retry: '1200',
      timestamp: 1730000000
    });
  });

  it('defaults event type to message when event field absent', () => {
    const output = assembleSseEvent(['data: {"ok":true}']);
    expect(output).toEqual({
      event: 'message',
      data: '{"ok":true}'
    });
  });
});

