import { describe, expect, it } from '@jest/globals';

describe('constants SSOT: provider defaults', () => {
  it('exposes API_BASE_URLS, PROVIDER_TIMEOUTS, PROVIDER_DEFAULT_MODELS, SSE_DEFAULT_CAPS', async () => {
    const mod = await import('../../src/constants/index.js');
    expect(mod.API_BASE_URLS).toBeDefined();
    expect(mod.PROVIDER_TIMEOUTS).toBeDefined();
    expect(mod.PROVIDER_DEFAULT_MODELS).toBeDefined();
    expect(mod.SSE_DEFAULT_CAPS).toBeDefined();
  });

  it('PROVIDER_DEFAULT_MODELS contains canonical model names', async () => {
    const { PROVIDER_DEFAULT_MODELS } = await import('../../src/constants/index.js');
    expect(PROVIDER_DEFAULT_MODELS.OPENAI_CHAT).toBe('gpt-4');
    expect(PROVIDER_DEFAULT_MODELS.ANTHROPIC).toBe('claude-3-haiku-20240307');
    expect(PROVIDER_DEFAULT_MODELS.GEMINI).toBe('models/gemini-2.0-flash');
    expect(PROVIDER_DEFAULT_MODELS.GLM).toBe('glm-4');
    expect(PROVIDER_DEFAULT_MODELS.QWEN).toBe('coder-model');
    expect(PROVIDER_DEFAULT_MODELS.DEEPSEEK).toBe('deepseek-chat');
  });

  it('PROVIDER_TIMEOUTS keys map to milliseconds', async () => {
    const { PROVIDER_TIMEOUTS } = await import('../../src/constants/index.js');
    for (const [k, v] of Object.entries(PROVIDER_TIMEOUTS)) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(60_000);
      expect(v).toBeLessThanOrEqual(600_000);
    }
    expect(PROVIDER_TIMEOUTS.QWEN).toBe(120_000);
  });

  it('service-profiles references constants instead of literal URLs', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/providers/core/config/service-profiles.ts', 'utf8');
    expect(src).toContain('API_BASE_URLS.GEMINI');
    expect(src).toContain('API_BASE_URLS.GLM');
    expect(src).toContain('API_BASE_URLS.QWEN');
    expect(src).toContain('API_BASE_URLS.DEEPSEEK');
    expect(src).toContain('PROVIDER_DEFAULT_MODELS.OPENAI_CHAT');
    expect(src).not.toMatch(/defaultBaseUrl: 'https:\/\/chat\.deepseek\.com'/);
    expect(src).not.toMatch(/defaultBaseUrl: 'https:\/\/dashscope\.aliyuncs\.com/);
  });
});
