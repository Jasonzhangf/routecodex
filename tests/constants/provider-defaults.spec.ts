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
  });

  it('PROVIDER_TIMEOUTS keys map to milliseconds', async () => {
    const { DEFAULT_TIMEOUTS, PROVIDER_TIMEOUTS } = await import('../../src/constants/index.js');
    for (const [k, v] of Object.entries(PROVIDER_TIMEOUTS)) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(60_000);
      expect(v).toBeLessThanOrEqual(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
    }
    expect(PROVIDER_TIMEOUTS.RESPONSES).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
  });

  it('aligns provider stream semantic timeouts with the 15 minute SSE total window', async () => {
    const { DEFAULT_TIMEOUTS, SSE_DEFAULT_CAPS } = await import('../../src/constants/index.js');
    expect(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS).toBe(900_000);
    expect(DEFAULT_TIMEOUTS.PROVIDER_STREAM_IDLE_CAP_MS).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
    expect(DEFAULT_TIMEOUTS.PROVIDER_STREAM_NO_CONTENT_TIMEOUT_MS).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
    expect(DEFAULT_TIMEOUTS.PROVIDER_STREAM_CONTENT_IDLE_TIMEOUT_MS).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
    expect(SSE_DEFAULT_CAPS.STREAM_IDLE_CAP_MS).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
    expect(SSE_DEFAULT_CAPS.STREAM_NO_CONTENT_TIMEOUT_MS).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
    expect(SSE_DEFAULT_CAPS.STREAM_CONTENT_IDLE_TIMEOUT_MS).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);

    const { BASE_SERVICE_PROFILES } = await import('../../src/providers/core/config/service-profiles.js');
    expect(BASE_SERVICE_PROFILES.responses.timeout).toBe(DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS);
  });

  it('service-profiles references constants instead of literal URLs', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/providers/core/config/service-profiles.ts', 'utf8');
    expect(src).toContain('API_BASE_URLS.GEMINI');
    expect(src).toContain('API_BASE_URLS.GLM');
    expect(src).toContain('PROVIDER_DEFAULT_MODELS.OPENAI_CHAT');
    expect(src).not.toMatch(/defaultBaseUrl: 'https:\/\/chat\.deepseek\.com'/);
    expect(src).not.toMatch(/defaultBaseUrl: 'https:\/\/dashscope\.aliyuncs\.com/);
  });
});
