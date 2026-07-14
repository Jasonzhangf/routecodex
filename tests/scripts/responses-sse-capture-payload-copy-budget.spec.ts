import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  createResponsesCaptureRequestOwner
} from '../../scripts/responses-sse-capture.mjs';

describe('feature_id: debug.responses_sse_capture_payload_copy_budget', () => {
  test('source rejects full-payload request clones and import-time CLI execution', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/responses-sse-capture.mjs'),
      'utf8'
    );

    expect(source).not.toContain('JSON.parse(JSON.stringify(rawReq))');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
    expect(source).toContain("import.meta.url === pathToFileURL(process.argv[1]).href");
  });

  test('creates one shallow top-level capture owner and preserves nested identities', () => {
    const parameters = { type: 'object', properties: { value: { type: 'string' } } };
    const tools = [{ type: 'function', name: 'lookup', parameters }];
    const input = [{ type: 'message', role: 'user', content: [] }];
    const metadata = { clientRequestId: 'req_1' };
    const source = {
      model: 'source-model',
      input,
      tools,
      metadata,
      instructions: 'source instructions',
      extension: { nested: true }
    };

    const owner = createResponsesCaptureRequestOwner(source);
    owner.model = 'capture-model';
    owner.instructions = 'capture instructions';
    owner.stream = true;

    expect(owner).not.toBe(source);
    expect(owner.input).toBe(input);
    expect(owner.tools).toBe(tools);
    expect(owner.metadata).toBe(metadata);
    expect(owner.extension).toBe(source.extension);
    expect(owner.tools[0].parameters).toBe(parameters);
    expect(source).toEqual({
      model: 'source-model',
      input,
      tools,
      metadata,
      instructions: 'source instructions',
      extension: { nested: true }
    });
  });

  test('instruction deletion remains top-level isolated', () => {
    const source = {
      input: [{ type: 'message', role: 'user', content: [] }],
      instructions: 'keep on source'
    };
    const owner = createResponsesCaptureRequestOwner(source);

    delete owner.instructions;

    expect(source.instructions).toBe('keep on source');
    expect(owner).not.toHaveProperty('instructions');
    expect(owner.input).toBe(source.input);
  });
});
