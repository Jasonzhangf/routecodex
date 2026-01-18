import fs from 'node:fs';
import path from 'node:path';

import { bootstrapVirtualRouterConfig, getHubPipelineCtor } from '../../src/modules/llmswitch/bridge.js';

type HubPipelineCtor = new (config: any) => {
  execute: (request: any) => Promise<any>;
};

function loadFixture(name: string): Record<string, unknown> {
  const p = path.resolve(process.cwd(), 'tests/fixtures/unified-hub', name);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function normalizeEntryProviderProtocol(entryEndpoint: string): string {
  const lowered = String(entryEndpoint || '').toLowerCase();
  if (lowered.includes('/v1/responses')) return 'openai-responses';
  if (lowered.includes('/v1/messages')) return 'anthropic-messages';
  return 'openai-chat';
}

function buildVirtualRouterConfig() {
  return {
    providers: {
      mockOpenai: {
        id: 'mockOpenai',
        enabled: true,
        type: 'openai',
        baseURL: 'mock://openai',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      },
      mockResponses: {
        id: 'mockResponses',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://responses',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      },
      mockAnthropic: {
        id: 'mockAnthropic',
        enabled: true,
        type: 'anthropic',
        baseURL: 'mock://anthropic',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      },
      mockGemini: {
        id: 'mockGemini',
        enabled: true,
        type: 'gemini',
        baseURL: 'mock://gemini',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [
        { id: 'default-primary', targets: ['mockOpenai.gpt-test'] }
      ],
      openai: [
        { id: 'openai-primary', targets: ['mockOpenai.gpt-test'] }
      ],
      responses: [
        { id: 'responses-primary', targets: ['mockResponses.gpt-test'] }
      ],
      anthropic: [
        { id: 'anthropic-primary', targets: ['mockAnthropic.gpt-test'] }
      ],
      gemini: [
        { id: 'gemini-primary', targets: ['mockGemini.gpt-test'] }
      ]
    }
  };
}

async function createHubPipelineCtor(): Promise<HubPipelineCtor> {
  return (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
}

async function runOnce(args: {
  requestId: string;
  mode: 'off' | 'observe';
  entryEndpoint: string;
  routeHint: string;
  payload: any;
}) {
  const HubPipeline = await createHubPipelineCtor();
  const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
  const pipeline = new HubPipeline({
    virtualRouter: artifacts.config,
    policy: { mode: args.mode }
  });
  const providerProtocol = normalizeEntryProviderProtocol(args.entryEndpoint);
  return await pipeline.execute({
    id: args.requestId,
    endpoint: args.entryEndpoint,
    payload: args.payload,
    metadata: {
      entryEndpoint: args.entryEndpoint,
      providerProtocol,
      routeHint: args.routeHint
    }
  });
}

function stableSubset(result: any) {
  return {
    providerPayload: result?.providerPayload,
    target: {
      providerKey: result?.target?.providerKey,
      providerType: result?.target?.providerType,
      outboundProfile: result?.target?.outboundProfile
    },
    metadata: {
      entryEndpoint: result?.metadata?.entryEndpoint,
      providerProtocol: result?.metadata?.providerProtocol,
      routeHint: result?.metadata?.routeHint,
      processMode: result?.metadata?.processMode,
      stream: result?.metadata?.stream
    }
  };
}

describe('Unified Hub V1 policy observe shadow', () => {
  it('does not change outputs for /v1/chat/completions', async () => {
    const payload = loadFixture('chat.json');
    const requestId = 'shadow_unified_hub_chat';
    const baseline = await runOnce({ requestId, mode: 'off', entryEndpoint: '/v1/chat/completions', routeHint: 'openai', payload });
    const candidate = await runOnce({ requestId, mode: 'observe', entryEndpoint: '/v1/chat/completions', routeHint: 'openai', payload });
    expect(stableSubset(candidate)).toEqual(stableSubset(baseline));
  });

  it('does not change outputs for /v1/responses', async () => {
    const payload = loadFixture('responses.json');
    const requestId = 'shadow_unified_hub_responses';
    const baseline = await runOnce({ requestId, mode: 'off', entryEndpoint: '/v1/responses', routeHint: 'responses', payload });
    const candidate = await runOnce({ requestId, mode: 'observe', entryEndpoint: '/v1/responses', routeHint: 'responses', payload });
    expect(stableSubset(candidate)).toEqual(stableSubset(baseline));
  });

  it('does not change outputs for /v1/messages', async () => {
    const payload = loadFixture('anthropic.json');
    const requestId = 'shadow_unified_hub_messages';
    const baseline = await runOnce({ requestId, mode: 'off', entryEndpoint: '/v1/messages', routeHint: 'anthropic', payload });
    const candidate = await runOnce({ requestId, mode: 'observe', entryEndpoint: '/v1/messages', routeHint: 'anthropic', payload });
    expect(stableSubset(candidate)).toEqual(stableSubset(baseline));
  });
});
