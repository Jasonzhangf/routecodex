import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeProvider } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/provider-normalization.js';

describe('provider normalization anthropic thinking config', () => {
  it('reads array-style model thinking by model id instead of array index', () => {
    const normalized = normalizeProvider('ali-coding-plan', {
      id: 'ali-coding-plan',
      type: 'anthropic',
      baseURL: 'https://example.test/anthropic',
      auth: { type: 'apikey', apiKey: 'test-key' },
      anthropicThinkingBudgets: { low: 2048, high: 8192 },
      models: [
        { id: 'qwen3.5-plus', capabilities: ['text', 'reasoning', 'thinking'] },
        { id: 'glm-5', capabilities: ['text', 'reasoning', 'thinking'], thinking: 'high' },
        {
          id: 'kimi-k2.5',
          capabilities: ['text', 'reasoning', 'thinking'],
          reasoning: { effort: 'medium' },
          anthropicThinkingBudgets: { medium: 4096 }
        }
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
    expect(normalized.defaultAnthropicThinkingBudgets).toEqual({
      low: 2048,
      high: 8192
    });
    expect(normalized.modelAnthropicThinkingBudgets).toEqual({
      'kimi-k2.5': { medium: 4096 }
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
});
