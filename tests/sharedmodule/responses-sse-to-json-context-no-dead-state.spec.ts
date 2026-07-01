import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { ResponsesSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.js';

describe('responses SSE-to-JSON dead-state boundary', () => {
  it('still materializes a completed response without converter-held state', async () => {
    const converter = new ResponsesSseToJsonConverter();
    const sseText = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_decode_dead_state","object":"response","created_at":1710000000,"status":"in_progress","model":"gpt-test","output":[]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_decode_dead_state","object":"response","created_at":1710000000,"status":"completed","model":"gpt-test","output":[]}}',
      '',
      'event: response.done',
      'data: {"type":"response.done","response":{"id":"resp_decode_dead_state","object":"response","created_at":1710000000,"status":"completed","model":"gpt-test","output":[]}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const response = await converter.convertSseToJson(sseText, {
      requestId: 'req_decode_dead_state',
      model: 'gpt-test'
    });

    expect(response.id).toBe('resp_decode_dead_state');
    expect(response.status).toBe('completed');
  });

  it('does not keep converter-level config or cross-request context cache', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('private config:');
    expect(source).not.toContain('constructor(config?');
    expect(source).not.toContain('this.config.');
    expect(source).not.toContain('private contexts = new Map');
    expect(source).not.toContain('this.contexts.set(');
    expect(source).not.toContain('getContext(requestId: string)');
    expect(source).not.toContain('clearContext(requestId: string)');
    expect(source).not.toContain('getActiveContexts(): Map<string, SseToResponsesJsonContext>');
    expect(source).not.toContain('enableStrictValidation: this.config.enableEventValidation');
    expect(source).not.toContain('validateSequenceNumber(');
    expect(source).not.toContain('lastSequenceNumber');
  });
});
