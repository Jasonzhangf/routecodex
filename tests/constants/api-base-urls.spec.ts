import { describe, expect, it } from '@jest/globals';

describe('constants SSOT: API_BASE_URLS', () => {
  it('exposes API_BASE_URLS with canonical providers', async () => {
    const { API_BASE_URLS } = await import('../../src/constants/index.js');
    expect(API_BASE_URLS.OPENAI).toBe('https://api.openai.com/v1');
    expect(API_BASE_URLS.ANTHROPIC).toBe('https://api.anthropic.com');
    expect(API_BASE_URLS.GEMINI).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(API_BASE_URLS.GLM).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(API_BASE_URLS.QWEN).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(API_BASE_URLS.DEEPSEEK).toBe('https://chat.deepseek.com');
  });
});
