import { describe, expect, it } from '@jest/globals';

import { buildProviderFromTemplate, getProviderTemplates, pickProviderTemplate } from '../../src/provider-sdk/provider-add-template.js';

describe('provider add templates', () => {
  it('exposes generic protocol templates plus managed-auth built-ins', () => {
    const templates = getProviderTemplates();
    expect(templates.some((tpl) => tpl.id === 'openai' && tpl.source === 'bootstrap-generic')).toBe(true);
    expect(templates.some((tpl) => tpl.id === 'responses' && tpl.source === 'bootstrap-generic')).toBe(true);
    expect(templates.some((tpl) => tpl.source === 'bootstrap-managed')).toBe(false);
    expect(templates.at(-1)?.id).toBe('custom');
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
