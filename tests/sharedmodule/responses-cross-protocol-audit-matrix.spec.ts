import { describe, expect, it } from '@jest/globals';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';
import { AnthropicSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/anthropic-mapper.js';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';

function createResponsesContext(requestId: string): AdapterContext {
  return {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };
}

function extractFieldSet(items: unknown): Set<string> {
  const rows = Array.isArray(items) ? items : [];
  return new Set(
    rows
      .map((entry) => (entry && typeof entry === 'object' ? String((entry as any).field || '') : ''))
      .filter((field) => field.length > 0)
  );
}

describe('responses cross-protocol dropped/lossy audit matrix', () => {
  it('records anthropic dropped/lossy audit for non-equivalent responses fields', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const ctx = createResponsesContext('req-resp-anthropic-audit-matrix');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-101',
          response_format: { type: 'json_object' },
          parallel_tool_calls: true,
          service_tier: 'default',
          truncation: 'disabled',
          include: ['output_text'],
          store: true,
          reasoning: { effort: 'medium' }
        }
      } as any,
      ctx
    );

    const outbound = await anthropicMapper.fromChat(chat, {
      requestId: 'req-resp-anthropic-out-audit-matrix',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.response_format).toBeUndefined();
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.service_tier).toBeUndefined();
    expect(payload.truncation).toBeUndefined();
    expect(payload.include).toBeUndefined();
    expect(payload.store).toBeUndefined();
    expect(payload.thinking).toBeDefined();

    const audit = (chat.metadata as any)?.mappingAudit;
    expect(audit).toBeDefined();
    const dropped = extractFieldSet(audit?.dropped);
    for (const field of [
      'prompt_cache_key',
      'response_format',
      'parallel_tool_calls',
      'service_tier',
      'truncation',
      'include',
      'store'
    ]) {
      expect(dropped.has(field)).toBe(true);
    }

    const lossy = extractFieldSet(audit?.lossy);
    expect(lossy.has('reasoning')).toBe(true);
  });

  it('records gemini dropped/lossy audit for non-equivalent responses fields', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const ctx = createResponsesContext('req-resp-gemini-audit-matrix');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-202',
          response_format: { type: 'json_object' },
          parallel_tool_calls: true,
          service_tier: 'default',
          truncation: 'disabled',
          include: ['output_text'],
          store: true,
          reasoning: { effort: 'high' }
        }
      } as any,
      ctx
    );

    const outbound = await geminiMapper.fromChat(chat, {
      requestId: 'req-resp-gemini-out-audit-matrix',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.response_format).toBeUndefined();
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.service_tier).toBeUndefined();
    expect(payload.truncation).toBeUndefined();
    expect(payload.include).toBeUndefined();
    expect(payload.store).toBeUndefined();
    expect(payload.generationConfig?.thinkingConfig).toBeDefined();

    const audit = (chat.metadata as any)?.mappingAudit;
    expect(audit).toBeDefined();
    const dropped = extractFieldSet(audit?.dropped);
    for (const field of [
      'prompt_cache_key',
      'response_format',
      'parallel_tool_calls',
      'service_tier',
      'truncation',
      'include',
      'store'
    ]) {
      expect(dropped.has(field)).toBe(true);
    }

    const lossy = extractFieldSet(audit?.lossy);
    expect(lossy.has('reasoning')).toBe(true);
  });
});
