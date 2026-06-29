import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';

const root = process.cwd();

function read(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

describe('responses request SSE no synthetic response boundary', () => {
  it('does not expose request-to-SSE conversion that fabricates response events', () => {
    const converter = new ResponsesJsonToSseConverterRefactored();

    expect((converter as any).convertRequestToJsonToSse).toBeUndefined();
  });

  it('does not keep the old synthetic request response sequencer', () => {
    const sequencer = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts');

    expect(sequencer).not.toContain('syntheticResponse');
    expect(sequencer).not.toContain('syntheticIndex');
    expect(sequencer).not.toContain('id: `${context.requestId}-input-${inputIndex}`');
    expect(sequencer).not.toContain('sequenceRequest(');
  });
});
