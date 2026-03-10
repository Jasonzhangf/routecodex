import { describe, expect, test } from '@jest/globals';

import { GeminiSemanticMapper } from '../../src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.js';
import { createHash } from 'node:crypto';

function stableSid(raw: string): string {
  return `sid-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

describe('gemini mapper antigravity defaults', () => {
  test('injects antigravity systemInstruction + safetySettings and clamps generationConfig when present', async () => {
    const mapper = new GeminiSemanticMapper();

    const ctx = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity.any'
    };

    const chat: any = {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        model: 'claude-sonnet-4-5-thinking',
        temperature: 0.2
      },
      metadata: { context: ctx }
    };

    const out = await mapper.fromChat(chat, ctx as any);
    const payload: any = out?.payload;

    expect(payload).toBeTruthy();
    expect(payload.systemInstruction).toBeTruthy();
    expect(Array.isArray(payload.systemInstruction.parts)).toBe(true);
    expect(payload.systemInstruction.parts[0]?.text).toContain('You are Antigravity');

    expect(Array.isArray(payload.safetySettings)).toBe(true);
    expect(payload.safetySettings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' })
      ])
    );

    expect(payload.generationConfig).toBeTruthy();
    expect(payload.generationConfig.temperature).toBe(0.2);
    expect(payload.generationConfig.maxOutputTokens).toBe(64000);
    expect(payload.generationConfig.topK).toBe(64);

    expect(payload.metadata).toBeTruthy();
    expect(payload.metadata.antigravitySessionId).toBe(stableSid('hi'));
  });

  test('does not force antigravity defaults on non-antigravity providers', async () => {
    const mapper = new GeminiSemanticMapper();

    const ctx = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli.any'
    };

    const chat: any = {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        model: 'models/gemini-pro'
      },
      metadata: { context: ctx }
    };

    const out = await mapper.fromChat(chat, ctx as any);
    const payload: any = out?.payload;

    expect(payload).toBeTruthy();
    expect(payload.systemInstruction?.parts?.[0]?.text).not.toContain('You are Antigravity');
  });
});
