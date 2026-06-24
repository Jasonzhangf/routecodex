import { jest } from '@jest/globals';

describe('system-prompt-loader responses merge', () => {
  const originalEnable = process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE;
  const originalSource = process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE;

  beforeEach(() => {
    jest.resetModules();
    process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE = '1';
    process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
  });

  afterEach(() => {
    if (originalEnable === undefined) {
      delete process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE;
    } else {
      process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE = originalEnable;
    }
    if (originalSource === undefined) {
      delete process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE;
    } else {
      process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = originalSource;
    }
  });

  test('preserves existing responses instructions while prepending override prompt', async () => {
    const { applySystemPromptOverride, getCodexSystemPrompt } = await import('../../src/utils/system-prompt-loader.js');

    const payload: Record<string, unknown> = {
      instructions: 'stopreason 取值：0=finished，1=blocked，2=continue_needed\n<rcc_stop_schema>',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行' }]
        }
      ]
    };

    applySystemPromptOverride('/v1/responses', payload);

    const merged = String(payload.instructions ?? '');
    const override = getCodexSystemPrompt() ?? '';
    expect(merged).toContain(override.trim());
    expect(merged).toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
    expect(merged).toContain('<rcc_stop_schema>');
    expect(merged.indexOf(override.trim())).toBe(0);
  });
});
