import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';

import { ProviderPreprocessHarness } from '../../src/debug/harness/provider.js';
import type {
  ProviderHarnessMetadata,
  ProviderHarnessRuntime
} from '../../src/debug/types.js';
import type { IProviderV2 } from '../../src/providers/core/api/provider-types.js';
import { ProviderFactory } from '../../src/providers/core/runtime/provider-factory.js';
import {
  extractProviderRuntimeMetadata
} from '../../src/providers/core/runtime/provider-runtime-metadata.js';

const runtime = {
  runtimeKey: 'debug-harness-copy-budget',
  providerId: 'mock-provider',
  providerKey: 'mock-provider:debug',
  providerType: 'mock',
  providerProtocol: 'openai',
  endpoint: 'https://example.test/v1/chat/completions',
  auth: { type: 'apikey', value: 'test-only' },
  defaultModel: 'mock-model'
} satisfies ProviderHarnessRuntime;

const metadata = {
  requestId: 'req-debug-harness-copy-budget',
  providerId: 'mock-provider',
  providerKey: 'mock-provider:debug',
  providerType: 'mock',
  providerProtocol: 'openai',
  routeName: 'default',
  target: {
    providerKey: 'mock-provider:debug'
  }
} as ProviderHarnessMetadata;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('debug.harness_replay_payload_copy_budget', () => {
  it('gives provider preprocess one independent execution graph without mutating captured replay input', async () => {
    const nested = { value: 'captured' };
    const request: Record<string, unknown> = {
      model: 'mock-model',
      nested,
      bigint: 42n
    };
    request.self = request;

    let providerInput: Record<string, unknown> | undefined;
    const provider = {
      initialize: jest.fn(async () => {}),
      preprocessRequest: jest.fn((value: Record<string, unknown>) => {
        providerInput = value;
        (value.nested as { value: string }).value = 'provider-mutated';
        value.providerOnly = true;
        return value;
      })
    } as unknown as IProviderV2;
    jest.spyOn(ProviderFactory, 'createProviderFromRuntime').mockReturnValue(provider);

    const result = await new ProviderPreprocessHarness().executeForward({
      runtime,
      request,
      metadata
    });

    expect(providerInput).toBe(result.payload);
    expect(providerInput).not.toBe(request);
    expect(providerInput?.nested).not.toBe(nested);
    expect(providerInput?.self).toBe(providerInput);
    expect(providerInput?.bigint).toBe(42n);
    expect(providerInput).toMatchObject({
      nested: { value: 'provider-mutated' },
      providerOnly: true
    });
    expect(request).toMatchObject({
      nested: { value: 'captured' }
    });
    expect(request).not.toHaveProperty('providerOnly');
    expect(extractProviderRuntimeMetadata(request)).toBeUndefined();
    expect(extractProviderRuntimeMetadata(providerInput)).toMatchObject({
      requestId: metadata.requestId,
      providerKey: metadata.providerKey
    });
  });

  it('keeps captured response input isolated from provider context and postprocess mutations', async () => {
    const capturedNested = { status: 'captured' };
    const capturedResponse: Record<string, unknown> = {
      id: 'response-debug-harness-copy-budget',
      nested: capturedNested
    };
    let contextInput: Record<string, unknown> | undefined;
    let postprocessInput: Record<string, unknown> | undefined;
    const provider = {
      initialize: jest.fn(async () => {}),
      createContext: jest.fn((value: Record<string, unknown>) => {
        contextInput = value;
        value.contextOnly = true;
        return { requestId: metadata.requestId };
      }),
      postprocessResponse: jest.fn((value: Record<string, unknown>) => {
        postprocessInput = value;
        (value.nested as { status: string }).status = 'postprocessed';
        return value;
      })
    } as unknown as IProviderV2;
    jest.spyOn(ProviderFactory, 'createProviderFromRuntime').mockReturnValue(provider);

    const result = await new ProviderPreprocessHarness().executeForward({
      runtime,
      request: capturedResponse,
      metadata,
      action: 'postprocess'
    });

    expect(contextInput).toBe(postprocessInput);
    expect(result.payload).toBe(postprocessInput);
    expect(postprocessInput).not.toBe(capturedResponse);
    expect(postprocessInput?.nested).not.toBe(capturedNested);
    expect(postprocessInput).toMatchObject({
      contextOnly: true,
      nested: { status: 'postprocessed' }
    });
    expect(capturedResponse).toEqual({
      id: 'response-debug-harness-copy-budget',
      nested: { status: 'captured' }
    });
    expect(extractProviderRuntimeMetadata(capturedResponse)).toBeUndefined();
  });

  it('uses the single Node structured-clone contract without a JSON compatibility copy', () => {
    const source = fs.readFileSync('src/debug/harness/provider.ts', 'utf8');

    expect(source).toContain('cloneProviderReplayInput');
    expect(source.match(/structuredClone\s*\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/);
    expect(source).not.toContain('function deepClone');
  });
});
