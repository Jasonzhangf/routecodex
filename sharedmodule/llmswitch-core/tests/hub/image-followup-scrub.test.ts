import { describe, expect, test } from '@jest/globals';

import { runHubChatProcess } from '../../src/conversion/hub/process/chat-process.js';

function extractImageTypesFromMessages(messages: any[]): string[] {
  const out: string[] = [];
  for (const msg of messages || []) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = typeof part?.type === 'string' ? String(part.type).toLowerCase() : '';
      if (type.includes('image')) out.push(type);
    }
  }
  return out;
}

function extractTextParts(messages: any[]): string[] {
  const texts: string[] = [];
  for (const msg of messages || []) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part?.text === 'string') texts.push(part.text);
    }
  }
  return texts;
}

describe('hub chat-process image scrubbing', () => {
  test('keeps image parts on a new user turn (last message is user)', async () => {
    const req: any = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'see' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        }
      ],
      tools: []
    };

    const out = await runHubChatProcess({
      request: req,
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      rawPayload: req,
      metadata: { providerProtocol: 'openai-responses' }
    });

    const processed: any = out.processedRequest;
    expect(processed).toBeTruthy();
    expect(extractImageTypesFromMessages(processed.messages)).toEqual(['input_image']);
  });

  test('replaces image parts with placeholder on followup turns (last message is tool/assistant)', async () => {
    const req: any = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'see' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'result' }
      ],
      tools: []
    };

    const out = await runHubChatProcess({
      request: req,
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      rawPayload: req,
      metadata: { providerProtocol: 'openai-responses' }
    });

    const processed: any = out.processedRequest;
    expect(processed).toBeTruthy();
    expect(extractImageTypesFromMessages(processed.messages)).toEqual([]);
    expect(extractTextParts(processed.messages)).toContain('[Image omitted]');
    expect((processed.metadata as any)?.hasImageAttachment).toBeUndefined();
  });
});

