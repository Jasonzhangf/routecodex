import { describe, expect, it } from '@jest/globals';

import { buildProviderFromTemplate, getProviderTemplates, pickProviderTemplate } from '../../src/provider-sdk/provider-add-template.js';

describe('provider add templates', () => {
  it('exposes generic protocol templates plus managed-auth built-ins', () => {
    const templates = getProviderTemplates();
    expect(templates.some((tpl) => tpl.id === 'openai' && tpl.source === 'bootstrap-generic')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'responses' && tpl.source === 'bootstrap-generic')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'qwen' && tpl.source === 'bootstrap-managed')).toBe(true);
    expect(templates.at(-1)?.id).toBe('custom');
  });

  it('keeps qwen managed template aligned to official qwen code defaults', () => {
    const qwenTemplate = getProviderTemplates().find((tpl) => tpl.id === 'qwen');
    expect(qwenTemplate).toBeTruthy();
    const provider = buildProviderFromTemplate(
      'qwen',
      qwenTemplate!,
      qwenTemplate!.defaultBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      qwenTemplate!.defaultAuthType || 'qwen-oauth',
      '',
      '~/.rcc/auth/qwen-oauth-1-default.json',
      'coder-model'
    ) as Record<string, any>;

    expect(provider.auth.type).toBe('qwen-oauth');
    expect(provider.auth.tokenFile).toBe('~/.rcc/auth/qwen-oauth-1-default.json');
    expect(provider.defaultModel).toBe('coder-model');
    expect(provider.models['coder-model']).toBeTruthy();
    expect(provider.models['qwen3.5-plus']).toBeTruthy();
    expect(provider.models['qwen3-coder-plus']).toBeUndefined();
    expect(provider.models['qwen3-vl-plus']).toBeUndefined();
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

  it('supports additional models and explicit defaultModel override', () => {
    const openaiTemplate = getProviderTemplates().find((tpl) => tpl.id === 'openai');
    expect(openaiTemplate).toBeTruthy();
    const provider = buildProviderFromTemplate(
      'openai',
      openaiTemplate!,
      openaiTemplate!.defaultBaseUrl || 'https://api.example.com/v1',
      'apikey',
      '${OPENAI_API_KEY}',
      '',
      'gpt-4.1-mini',
      {
        additionalModelIds: ['gpt-5.2-codex'],
        defaultModelId: 'gpt-5.2-codex'
      }
    ) as Record<string, any>;

    expect(provider.models['gpt-4.1-mini']).toBeTruthy();
    expect(provider.models['gpt-5.2-codex']).toBeTruthy();
    expect(provider.defaultModel).toBe('gpt-5.2-codex');
  });

  it('picks first template on empty id and custom template on unknown id', () => {
    const first = pickProviderTemplate('');
    const unknown = pickProviderTemplate('not-exists');
    expect(first.id).toBe('openai');
    expect(unknown.id).toBe('custom');
  });

  it('adds responses defaults and defaultCompat when missing in provider template', () => {
    const responses = pickProviderTemplate('responses');
    const provider = buildProviderFromTemplate(
      'responses',
      responses,
      'https://api.example.com/v1',
      'apikey',
      '${RESPONSES_API_KEY}',
      '',
      'resp-model'
    ) as Record<string, any>;
    expect(provider.responses).toEqual({ process: 'chat', streaming: 'always' });
    expect(provider.defaultModel).toBe('resp-model');

    const compatTemplate = {
      id: 'x',
      label: 'x',
      source: 'builtin',
      providerTypeHint: 'openai',
      defaultCompat: 'chat:compat',
      providerTemplate: {
        auth: { type: 'apikey' },
        models: {}
      }
    } as any;
    const compatProvider = buildProviderFromTemplate(
      'x',
      compatTemplate,
      'https://api.example.com/v1',
      'apikey',
      '${X_API_KEY}',
      '',
      'm1'
    ) as Record<string, any>;
    expect(compatProvider.compatibilityProfile).toBe('chat:compat');
  });

  it('supports oauth/tokenFile auth and fallback api key handling', () => {
    const provider = buildProviderFromTemplate(
      'custom',
      {
        id: 'custom',
        label: 'Custom',
        source: 'builtin',
        providerTypeHint: 'openai'
      } as any,
      'https://api.example.com/v1',
      'oauth',
      '',
      '~/.rcc/auth/custom-oauth.json',
      'model-a'
    ) as Record<string, any>;
    expect(provider.auth.type).toBe('oauth');
    expect(provider.auth.tokenFile).toBe('~/.rcc/auth/custom-oauth.json');

    const apikeyFallback = buildProviderFromTemplate(
      'custom-2',
      {
        id: 'custom',
        label: 'Custom',
        source: 'builtin',
        providerTypeHint: 'openai'
      } as any,
      'https://api.example.com/v1',
      'apikey',
      '',
      '',
      'model-a'
    ) as Record<string, any>;
    expect(apikeyFallback.auth.apiKey).toBe('YOUR_API_KEY_HERE');
  });
});
