import fs from 'node:fs';

import { normalizeProvider } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/provider-normalization.js';

describe('provider streaming capability normalization', () => {
  test('treats model supportsStreaming as capability auto instead of forcing always', () => {
    const normalized = normalizeProvider('qwenchat', {
      id: 'qwenchat',
      type: 'openai',
      baseURL: 'https://chat.qwen.ai',
      auth: { type: 'qwen-oauth', tokenFile: 'qwen-oauth-1-default' },
      models: {
        'qwen3.6-plus': { supportsStreaming: true },
        'qwen3.5-flash': { supportsStreaming: false }
      }
    });

    expect(normalized.streaming).toBeUndefined();
    expect(normalized.modelStreaming?.['qwen3.6-plus']).toBe('auto');
    expect(normalized.modelStreaming?.['qwen3.5-flash']).toBe('never');
  });

  test('treats provider-level supportsStreaming as capability auto instead of forcing always', () => {
    const normalized = normalizeProvider('provider-auto-stream', {
      id: 'provider-auto-stream',
      type: 'openai',
      baseURL: 'https://example.test/openai',
      auth: { type: 'apikey', apiKey: 'test-key' },
      supportsStreaming: true,
      models: {
        'default-model': { maxTokens: 4096 }
      }
    });

    expect(normalized.streaming).toBe('auto');
  });

  test('real qwenchat config no longer forces qwen3.6-plus outbound streaming', () => {
    const raw = JSON.parse(fs.readFileSync('/Volumes/extension/.rcc/provider/qwenchat/config.v2.json', 'utf8'));
    const normalized = normalizeProvider('qwenchat', raw.provider ?? raw);

    expect(normalized.modelStreaming?.['qwen3.6-plus']).toBe('auto');
  });
});
