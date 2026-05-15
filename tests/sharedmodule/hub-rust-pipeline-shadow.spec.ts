/**
 * HubPipeline Rust Shadow Test
 * Phase 1 Slice 0: Verify Rust runHubPipelineJson can process real fixture payloads.
 * Uses existing native-hub-pipeline-orchestration-semantics.ts wrapper.
 */
import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface HubPipelineInput {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  payload: unknown;
  metadata: unknown;
  stream?: boolean;
  processMode?: string;
  direction?: string;
  stage?: string;
}

interface HubPipelineOutput {
  payload?: unknown;
  orchestrationMetadata?: unknown;
  error?: { code?: string; message?: string };
}

let _semantics: typeof import('../../sharedmodule/llmswitch-core/dist/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js') | null = null;

async function getSemantics() {
  if (!_semantics) {
    const p = pathToFileURL(
      path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist', 'router', 'virtual-router', 'engine-selection', 'native-hub-pipeline-orchestration-semantics.js')
    ).href;
    _semantics = await import(p);
  }
  return _semantics;
}

async function runRustPipeline(input: HubPipelineInput): Promise<HubPipelineOutput> {
  const semantics = await getSemantics();
  if (!semantics || typeof (semantics as any).runHubPipelineOrchestrationWithNative !== 'function') {
    return { error: { code: 'NATIVE_UNAVAILABLE', message: 'runHubPipelineOrchestrationWithNative not found' } };
  }
  try {
    const result = (semantics as any).runHubPipelineOrchestrationWithNative(input);
    if (!result || typeof result !== 'object') {
      return { error: { code: 'EMPTY_RESULT', message: 'Rust returned non-object' } };
    }
    if ((result as any).error && !(result as any).payload) {
      return { error: (result as any).error };
    }
    return result as HubPipelineOutput;
  } catch (e) {
    return { error: { code: 'CALL_ERROR', message: String(e) } };
  }
}

function makeInput(fixtureData: unknown, protocol: string, endpoint: string, routeHint: string): HubPipelineInput {
  return {
    requestId: `rust_shadow_${Date.now()}`,
    endpoint,
    entryEndpoint: endpoint,
    providerProtocol: protocol,
    payload: fixtureData,
    metadata: {
      entryEndpoint: endpoint,
      providerProtocol: protocol,
      routeHint,
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
    },
    stream: false,
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
  };
}

function loadFixture(fixturePath: string): unknown {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`[rust-shadow] Fixture not found: ${fixturePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const data = raw?.data?.body ?? raw?.data ?? raw ?? null;
  if (!data) {
    throw new Error(`[rust-shadow] Fixture is empty: ${fixturePath}`);
  }
  return data;
}

describe('HubPipeline Rust Shadow', () => {
  const base = path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'tests', 'fixtures', 'codex-samples');

  test('openai-chat: Rust pipeline processes real fixture', async () => {
    const data = loadFixture(path.join(base, 'openai-chat', 'sample_provider-request.json'));
    const result = await runRustPipeline(makeInput(data, 'openai', '/v1/chat/completions', 'openai'));
    console.log('[rust-shadow] openai-chat:', result.error ?? 'OK');
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.payload).toBeDefined();
  });

  test('anthropic-messages: Rust pipeline processes anthropic fixture', async () => {
    const data = loadFixture(path.join(base, 'anthropic-messages', 'sample_provider-request.json'));
    const result = await runRustPipeline(makeInput(data, 'anthropic', '/v1/messages', 'anthropic'));
    console.log('[rust-shadow] anthropic:', result.error ?? 'OK');
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.payload).toBeDefined();
  });

  test('openai-responses: Rust pipeline processes responses fixture', async () => {
    const data = loadFixture(path.join(base, 'openai-responses', 'sample_provider-request.json'));
    const result = await runRustPipeline(makeInput(data, 'openai-responses', '/v1/responses', 'responses'));
    console.log('[rust-shadow] openai-responses:', result.error ?? 'OK');
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.payload).toBeDefined();
  });
});
