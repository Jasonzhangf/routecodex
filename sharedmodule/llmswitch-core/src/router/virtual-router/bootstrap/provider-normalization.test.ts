import { normalizeProvider } from './provider-normalization.js';
import fs from 'node:fs';
import path from 'node:path';

describe('normalizeProvider anthropic thinking config', () => {
  it('reads model-level anthropic thinking from provider config', () => {
    const normalized = normalizeProvider('ali-coding-plan', {
      id: 'ali-coding-plan',
      type: 'anthropic',
      baseURL: 'https://example.test/anthropic',
      auth: { type: 'apikey', apiKey: 'test-key' },
      models: {
        'glm-5': {
          supportsStreaming: true,
          thinking: 'high'
        },
        'glm-4.7': {
          supportsStreaming: true,
          reasoning: { effort: 'medium' }
        }
      }
    });

    expect(normalized.modelAnthropicThinking).toEqual({
      'glm-5': 'high',
      'glm-4.7': 'medium'
    });
  });

  it('reads provider-level anthropic thinking default when model override is absent', () => {
    const normalized = normalizeProvider('tabglm', {
      id: 'tabglm',
      type: 'anthropic',
      baseURL: 'https://example.test/anthropic',
      auth: { type: 'apikey', apiKey: 'test-key' },
      thinking: 'medium',
      models: {
        'glm-5': {
          supportsStreaming: true
        }
      }
    });

    expect(normalized.defaultAnthropicThinking).toBe('medium');
  });

  it('reads array-style provider config model thinking by model id instead of array index', () => {
    const normalized = normalizeProvider('ali-coding-plan', {
      id: 'ali-coding-plan',
      type: 'anthropic',
      baseURL: 'https://example.test/anthropic',
      auth: { type: 'apikey', apiKey: 'test-key' },
      models: [
        { id: 'qwen3.5-plus', capabilities: ['text', 'reasoning', 'thinking'] },
        { id: 'glm-5', capabilities: ['text', 'reasoning', 'thinking'], thinking: 'high' },
        { id: 'kimi-k2.5', capabilities: ['text', 'reasoning', 'thinking'], reasoning: { effort: 'medium' } }
      ]
    });

    expect(normalized.modelAnthropicThinking).toEqual({
      'glm-5': 'high',
      'kimi-k2.5': 'medium'
    });
    expect(normalized.modelAnthropicThinkingConfig).toEqual({
      'glm-5': { effort: 'high' },
      'kimi-k2.5': { effort: 'medium' }
    });
  });

  it('normalizes the real ali-coding-plan provider config with model ids', () => {
    const configPath = path.join(process.cwd(), 'config', 'providers', 'ali-coding-plan.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const normalized = normalizeProvider('ali-coding-plan', raw);

    expect(normalized.modelAnthropicThinking?.['glm-5']).toBe('high');
    expect(normalized.modelAnthropicThinking?.['glm-4.7']).toBe('high');
    expect(normalized.modelAnthropicThinking?.['kimi-k2.5']).toBe('high');
    expect(normalized.modelAnthropicThinking?.['1']).toBeUndefined();
    expect(normalized.modelAnthropicThinkingConfig?.['glm-5']).toEqual({ effort: 'high' });
    expect(normalized.modelAnthropicThinkingConfig?.['kimi-k2.5']).toEqual({ effort: 'high' });
    expect(normalized.modelAnthropicThinkingConfig?.['1']).toBeUndefined();
  });

  it('maps multimodal capability alias to vision capability', () => {
    const normalized = normalizeProvider('alias-test', {
      id: 'alias-test',
      type: 'openai',
      baseURL: 'https://example.test/openai',
      auth: { type: 'apikey', apiKey: 'test-key' },
      models: {
        'qwen3.5-plus': {
          supportsStreaming: true,
          capabilities: ['text', 'multimodal', 'vision']
        }
      }
    });

    expect(normalized.modelCapabilities?.['qwen3.5-plus']).toEqual(['text', 'vision']);
  });

  it('maps websearch capability aliases to web_search', () => {
    const normalized = normalizeProvider('alias-test', {
      id: 'alias-test',
      type: 'openai',
      baseURL: 'https://example.test/openai',
      auth: { type: 'apikey', apiKey: 'test-key' },
      models: {
        'glm-5': {
          supportsStreaming: true,
          capabilities: ['text', 'websearch', 'web-search', 'search', 'web_search']
        }
      }
    });

    expect(normalized.modelCapabilities?.['glm-5']).toEqual(['text', 'web_search']);
  });
});
