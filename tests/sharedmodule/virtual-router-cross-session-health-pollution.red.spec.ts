import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildConfig(): any {
  return {
    routing: {
      thinking: [
        { id: 'thinking-primary', priority: 100, mode: 'priority', targets: ['sdfv.key1.gpt-5.4'] },
        { id: 'thinking-backup', priority: 200, mode: 'priority', backup: true, targets: ['mimo.key1.mimo-v2.5-pro'] }
      ],
      default: [
        { id: 'default-primary', priority: 100, mode: 'priority', targets: ['sdfv.key1.gpt-5.4'] }
      ]
    },
    providers: {
      'sdfv.key1.gpt-5.4': {
        providerKey: 'sdfv.key1.gpt-5.4',
        providerType: 'responses',
        endpoint: 'https://example.invalid/v1',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-responses',
        modelId: 'gpt-5.4',
        modelCapabilities: { 'gpt-5.4': ['web_search'] }
      },
      'mimo.key1.mimo-v2.5-pro': {
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        providerType: 'anthropic',
        endpoint: 'https://example.invalid/anthropic',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'anthropic-messages',
        modelId: 'mimo-v2.5-pro',
        modelCapabilities: { 'mimo-v2.5-pro': ['text', 'reasoning', 'thinking', 'longcontext'] }
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'priority' },
    health: { failureThreshold: 3, cooldownMs: 30000, fatalCooldownMs: 120000 }
  };
}

function buildMetadata(requestId: string, sessionDir: string): any {
  return {
    requestId,
    routecodexRoutingPolicyGroup: 'gateway_priority_5555',
    __rt: { sessionDir }
  };
}

function buildRequest(): any {
  return {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: '继续执行' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
        }
      }
    ]
  };
}

describe('virtual router cross-session health isolation', () => {
  test('503 cooldown recorded for one sessionDir must not demote primary provider in another sessionDir', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-b-'));
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig() as any);

    const first = engine.route(buildRequest(), buildMetadata('req-a1', dirA));
    expect(first.target.providerKey).toBe('sdfv.key1.gpt-5.4');

    engine.handleProviderError({
      code: 'HTTP_503',
      message: 'provider unavailable',
      stage: 'provider.send',
      status: 503,
      runtime: {
        requestId: 'req-a1',
        routeName: 'thinking',
        providerKey: 'sdfv.key1.gpt-5.4'
      },
      timestamp: Date.now(),
      details: { errorClassification: 'recoverable' }
    } as any);

    const second = engine.route(buildRequest(), buildMetadata('req-b1', dirB));
    expect(second.target.providerKey).toBe('sdfv.key1.gpt-5.4');
  });
});
