import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  convertEventsToResponsesJson
} from '../../sharedmodule/llmswitch-core/scripts/lib/responses-sse-utils.mjs';

describe('feature_id: debug.responses_sse_utils_payload_copy_budget', () => {
  test('source rejects completed-response deep clones and unreachable duplicate branch', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/scripts/lib/responses-sse-utils.mjs'),
      'utf8'
    );

    expect(source).not.toContain('JSON.parse(JSON.stringify(event.response))');
    expect(source).not.toContain('JSON.parse(JSON.stringify(resp))');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
  });

  test('borrows the completed response without copying or mutation', async () => {
    const response = {
      id: 'resp_complete_1',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
      extension: { nested: true }
    };
    const events = [{ type: 'response.completed', response }];

    const result = await convertEventsToResponsesJson(events, { requestId: 'req_1' });

    expect(result.response).toBe(response);
    expect(result.response.output).toBe(response.output);
    expect(result.response.extension).toBe(response.extension);
    expect(events[0].response).toEqual(response);
  });

  test('still synthesizes a response when no completed event exists', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_partial', model: 'gpt-test' } },
      { type: 'response.output_text.delta', delta: 'hello' }
    ];

    const result = await convertEventsToResponsesJson(events, { requestId: 'req_2' });

    expect(result.response).toMatchObject({
      id: 'resp_partial',
      model: 'gpt-test',
      status: 'completed',
      output_text: 'hello'
    });
    expect(result.response).not.toBe(events[0].response);
  });
});
