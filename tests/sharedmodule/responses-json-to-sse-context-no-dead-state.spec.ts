import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('responses JSON-to-SSE context dead-state boundary', () => {
  it('still projects a completed response without dead context fields', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse({
      id: 'resp_context_boundary',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2
      }
    } as any, {
      requestId: 'req_context_boundary',
      model: 'gpt-test'
    });

    const body = await readStreamBody(stream);

    expect(body).toContain('event: response.completed');
    expect(body).not.toContain('responsesRequest');
    expect(body).not.toContain('outputItemStates');
  });

  it('does not keep the old fake context fields in the converter source', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('responsesRequest: {} as any');
    expect(source).not.toContain('outputItemStates: new Map()');
  });

  it('does not keep converter-level context cache or active-context APIs', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('CONTEXT_TTL_MS');
    expect(source).not.toContain('MAX_CONTEXTS');
    expect(source).not.toContain('pruneResponsesContexts');
    expect(source).not.toContain('private contexts = new Map');
    expect(source).not.toContain('getActiveContexts(');
    expect(source).not.toContain('getContext(');
    expect(source).not.toContain('clearContext(');
  });
});
