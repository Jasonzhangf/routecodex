import { describe, expect, it } from '@jest/globals';

import { buildProviderFromTemplate, getProviderTemplates } from '../../src/provider-sdk/provider-add-template.js';

describe('provider add templates', () => {
  it('exposes generic protocol templates plus managed-auth built-ins', () => {
    const templates = getProviderTemplates();
    expect(templates.some((tpl) => tpl.id === 'openai' && tpl.source === 'bootstrap-generic')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'responses' && tpl.source === 'bootstrap-generic')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'qwen' && tpl.source === 'bootstrap-managed')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'iflow' && tpl.source === 'bootstrap-managed')).toBe(true);
    expect(templates.at(-1)?.id).toBe('custom');
  });

  it('preserves runtime-specific auth defaults from managed templates', () => {
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

  it('supports credential-file overrides for account-style templates', () => {
    const deepseekTemplate = getProviderTemplates().find((tpl) => tpl.id === 'deepseek-web');
    expect(deepseekTemplate).toBeTruthy();
    const provider = buildProviderFromTemplate(
      'deepseek-web',
      deepseekTemplate!,
      deepseekTemplate!.defaultBaseUrl || 'https://chat.deepseek.com',
      deepseekTemplate!.defaultAuthType || 'deepseek-account',
      '',
      '~/.routecodex/auth/deepseek-account-custom.json',
      'deepseek-chat'
    ) as Record<string, any>;

    expect(provider.auth.type).toBe('deepseek-account');
    expect(provider.auth.entries[0].tokenFile).toBe('~/.routecodex/auth/deepseek-account-custom.json');
  });
});
