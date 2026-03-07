import { describe, expect, it } from '@jest/globals';

import { buildProviderFromTemplate, getProviderTemplates } from '../../src/provider-sdk/provider-add-template.js';

describe('provider add templates', () => {
  it('uses init-provider catalog instead of the old hardcoded template list', () => {
    const templates = getProviderTemplates();
    expect(templates.some((tpl) => tpl.id === 'openai' && tpl.source === 'catalog')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'qwen' && tpl.defaultModel === 'qwen3-coder-plus')).toBe(true);
    expect(templates.at(-1)?.id).toBe('custom');
  });

  it('preserves runtime-specific auth defaults from catalog-backed templates', () => {
    const iflowTemplate = getProviderTemplates().find((tpl) => tpl.id === 'iflow');
    expect(iflowTemplate).toBeTruthy();
    const provider = buildProviderFromTemplate(
      'iflow',
      iflowTemplate!,
      iflowTemplate!.defaultBaseUrl || 'https://apis.iflow.cn/v1',
      iflowTemplate!.defaultAuthType || 'iflow-cookie',
      '',
      '',
      'qwen3-coder-plus'
    ) as Record<string, any>;

    expect(provider.type).toBe('iflow');
    expect(provider.auth.type).toBe('iflow-cookie');
    expect(provider.auth.cookieFile).toBe('~/.routecodex/auth/iflow-work.cookie');
    expect(provider.models['qwen3-coder-plus']).toBeTruthy();
  });
});
