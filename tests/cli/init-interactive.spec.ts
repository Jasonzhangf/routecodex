import { describe, expect, it } from '@jest/globals';

import {
  interactiveCreateCustomProvider,
  interactiveHostPort,
  interactivePickDefaultProvider,
  interactiveRoutingWizard,
  interactiveSelectProviders,
  isValidTargetFormat,
  promptYesNo
} from '../../src/cli/commands/init/interactive.js';

function queuePrompt(answers: string[]) {
  let index = 0;
  return async (_question: string): Promise<string> => {
    const next = answers[index];
    index += 1;
    return next ?? '';
  };
}

const logger = {
  info: () => {},
  warning: () => {},
  success: () => {},
  error: () => {}
};

describe('init interactive helpers', () => {
  it('creates custom provider with multi-model input and responses preset', async () => {
    const prompt = queuePrompt([
      'my-provider',
      '2',
      '',
      'gpt-5.2,gpt-5.2-codex',
      ''
    ]);
    const result = await interactiveCreateCustomProvider(prompt, new Set(), logger);
    expect(result?.providerId).toBe('my-provider');
    expect(result?.providerNode.defaultModel).toBe('gpt-5.2');
    expect((result?.providerNode.models as Record<string, unknown>)['gpt-5.2-codex']).toBeTruthy();
    expect(result?.providerNode.auth).toEqual({ type: 'apikey', apiKey: '${MY_PROVIDER_API_KEY}' });
    expect(result?.providerNode.responses).toEqual({ process: 'chat', streaming: 'always' });
  });

  it('rejects invalid/duplicate/back custom provider flows', async () => {
    const empty = await interactiveCreateCustomProvider(queuePrompt(['']), new Set(), logger);
    expect(empty).toBeNull();

    const invalid = await interactiveCreateCustomProvider(queuePrompt(['BadUpper']), new Set(), logger);
    expect(invalid).toBeNull();

    const duplicated = await interactiveCreateCustomProvider(queuePrompt(['dup']), new Set(['dup']), logger);
    expect(duplicated).toBeNull();

    const backed = await interactiveCreateCustomProvider(queuePrompt(['b']), new Set(), logger);
    expect(backed).toBeNull();

    const backFromProtocol = await interactiveCreateCustomProvider(queuePrompt(['demo', 'back']), new Set(), logger);
    expect(backFromProtocol).toBeNull();

    const backFromBaseUrl = await interactiveCreateCustomProvider(queuePrompt(['demo1', '1', 'b']), new Set(), logger);
    expect(backFromBaseUrl).toBeNull();

    const backFromModelIds = await interactiveCreateCustomProvider(queuePrompt(['demo2', '1', '', 'b']), new Set(), logger);
    expect(backFromModelIds).toBeNull();

    const backFromEnv = await interactiveCreateCustomProvider(queuePrompt(['demo3', '1', '', 'model-a', 'b']), new Set(), logger);
    expect(backFromEnv).toBeNull();
  });

  it('handles provider selection/default picker and host-port prompts', async () => {
    const catalog = [
      { id: 'openai', label: 'OpenAI' },
      { id: 'qwen', label: 'Qwen' }
    ] as Array<{ id: string; label: string }>;

    const selected = await interactiveSelectProviders(queuePrompt(['1', '2', 'd']), catalog as any);
    expect(selected.map((item) => item.id).sort()).toEqual(['openai', 'qwen']);

    const defaultProvider = await interactivePickDefaultProvider(queuePrompt(['2']), selected as any);
    expect(defaultProvider).toBe('qwen');
    const defaultFallback = await interactivePickDefaultProvider(queuePrompt(['']), selected as any);
    expect(defaultFallback).toBe('openai');

    const hostPort = await interactiveHostPort(queuePrompt([' 0.0.0.0 ', ' 6001 ']), { host: '127.0.0.1', port: 5555 });
    expect(hostPort).toEqual({ host: '0.0.0.0', port: 6001 });

    const fallbackSelected = await interactiveSelectProviders(queuePrompt(['done', '']), catalog as any);
    expect(fallbackSelected.map((item) => item.id)).toEqual(['openai']);
  });

  it('supports yes/no prompt defaults', async () => {
    expect(await promptYesNo(queuePrompt(['']), 'Continue?', true)).toBe(true);
    expect(await promptYesNo(queuePrompt(['no']), 'Continue?', true)).toBe(false);
    expect(await promptYesNo(queuePrompt(['yes']), 'Continue?', false)).toBe(true);
    expect(await promptYesNo(queuePrompt(['???']), 'Continue?', false)).toBe(false);
  });

  it('runs routing wizard with skip/back/edit/save flow and keeps extra routes', async () => {
    const existing = {
      default: [{ targets: ['openai.gpt-4.1'] }],
      thinking: [{ targets: ['openai.gpt-4.1'] }],
      tools: [{ targets: ['openai.gpt-4.1'] }],
      longcontext: [{ targets: ['qwen.qwen-plus'] }]
    };
    const prompt = queuePrompt([
      '', // keep default
      'invalid-target', // invalid thinking
      'b', // back to default
      'openai.gpt-5.2', // default
      '', // skip thinking
      '', // skip tools
      'default', // edit summary
      'openai.gpt-5.2', // set default in summary
      'thinking', // edit summary
      'qwen.qwen-plus', // set thinking
      'save'
    ]);
    const routing = await interactiveRoutingWizard(prompt, existing as any, 'openai.gpt-4.1');
    expect(routing).not.toBeNull();
    expect((routing as any).default[0].targets[0]).toMatch(/^openai\./);
    expect((routing as any).thinking[0].targets[0]).toBe('qwen.qwen-plus');
    expect((routing as any).longcontext[0].targets[0]).toBe('qwen.qwen-plus');
  });

  it('validates routing target format and supports cancel from wizard', async () => {
    expect(isValidTargetFormat('provider.model')).toBe(true);
    expect(isValidTargetFormat('provider')).toBe(false);
    expect(isValidTargetFormat(' . ')).toBe(false);

    const cancelled = await interactiveRoutingWizard(queuePrompt(['b']), { default: [{ targets: ['a.m'] }] } as any, 'a.m');
    expect(cancelled).toBeNull();

    const summaryCancelled = await interactiveRoutingWizard(
      queuePrompt(['', '', '', 'b']),
      { default: [{ targets: ['a.m'] }] } as any,
      'a.m'
    );
    expect(summaryCancelled).toBeNull();
  });
});
