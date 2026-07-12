import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildChoicesArrayBridgeDebugDetailsWithNative,
  buildProviderResponseTimingBreakdownWithNative,
} from '../../../../../src/modules/llmswitch/bridge/provider-response-native-calls.js';
import { shouldAllowDirectResponsesPrebuiltSsePassthrough } from '../../../../../src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sharedBlocksSourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts'
);
const converterSourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/provider-response-converter.ts'
);

describe('provider-response shared pure blocks', () => {
  it('does not keep native-backed TS fallback paths beside Rust shared blocks', () => {
    const source = fs.readFileSync(sharedBlocksSourcePath, 'utf8');

    expect(source).not.toContain('withNativeBinding');
    expect(source).not.toContain('return fallback()');
    expect(source).not.toContain('TS fallback');
    expect(source).not.toContain('fall through');
    expect(source).toContain('shouldAllowDirectResponsesPrebuiltSsePassthroughWithNative(args)');
    expect(source).not.toContain("entry.includes('/v1/responses')");
    expect(source).not.toContain("args.providerProtocol !== 'openai-responses'");
    expect(source).not.toContain("args.continuationOwner === 'direct'");
  });

  it('keeps choices-array bridge debug details Rust-owned', () => {
    const source = fs.readFileSync(converterSourcePath, 'utf8');

    expect(source).toContain('buildChoicesArrayBridgeDebugDetailsWithNative');
    expect(source).not.toContain('function buildChoicesArrayBridgeDebugDetails');
    expect(source).not.toContain("args.message.toLowerCase().includes('choices array')");
    expect(source).not.toContain('bridgePayloadHasDataChoices: Array.isArray');

    expect(buildChoicesArrayBridgeDebugDetailsWithNative({
      message: 'plain validation error',
      bridgeProviderProtocol: 'openai-responses',
      bridgeSeed: { body: { data: { choices: [] } } },
      bridgePayload: { data: { choices: [] } }
    })).toEqual({});

    expect(buildChoicesArrayBridgeDebugDetailsWithNative({
      message: 'Expected choices array in provider response',
      bridgeProviderProtocol: 'openai-responses',
      bridgeSeed: { body: {}, status: 200 },
      bridgePayload: { data: { choices: [] } }
    })).toEqual({
      bridgeProviderProtocol: 'openai-responses',
      bridgeSeedKeys: ['body', 'status'],
      bridgePayloadKeys: ['data'],
      bridgePayloadHasChoices: false,
      bridgePayloadHasDataChoices: true
    });
  });

  it('RED: keeps provider-response timing breakdown projection Rust-owned', () => {
    const source = fs.readFileSync(converterSourcePath, 'utf8');

    expect(source).toContain('buildProviderResponseTimingBreakdownWithNative');
    expect(source).not.toContain('function attachTimingBreakdown');
    expect(source).not.toContain('clientInjectWaitMsRaw');
    expect(source).not.toContain('hubResponseExcludedMs: response.timingBreakdown?.hubResponseExcludedMs ?? clientInjectWaitMs');

    expect(buildProviderResponseTimingBreakdownWithNative({
      body: { object: 'chat.completion' },
      usageLogInfo: { clientInjectWaitMs: 12.9 },
      timingBreakdown: { upstreamMs: 50 }
    })).toEqual({
      body: { object: 'chat.completion' },
      usageLogInfo: { clientInjectWaitMs: 12.9 },
      timingBreakdown: {
        upstreamMs: 50,
        clientInjectWaitMs: 12,
        hubResponseExcludedMs: 12
      }
    });

    expect(buildProviderResponseTimingBreakdownWithNative({
      body: { object: 'chat.completion' },
      usageLogInfo: { clientInjectWaitMs: -1 },
      timingBreakdown: { upstreamMs: 50 }
    })).toEqual({
      body: { object: 'chat.completion' },
      usageLogInfo: { clientInjectWaitMs: -1 },
      timingBreakdown: {
        upstreamMs: 50,
        clientInjectWaitMs: 0,
        hubResponseExcludedMs: 0
      }
    });

    const withoutClientInject = {
      body: { object: 'chat.completion' },
      usageLogInfo: {},
      timingBreakdown: { upstreamMs: 50 }
    };
    expect(buildProviderResponseTimingBreakdownWithNative(withoutClientInject)).toEqual(withoutClientInject);

    const sseStream = { marker: 'non-json stream identity' };
    const projected = buildProviderResponseTimingBreakdownWithNative({
      body: { object: 'chat.completion' },
      sseStream,
      usageLogInfo: { clientInjectWaitMs: 9.7 }
    });
    expect(projected.sseStream).toBe(sseStream);
    expect(projected.timingBreakdown).toEqual({
      clientInjectWaitMs: 9,
      hubResponseExcludedMs: 9
    });
  });

  it('allows prebuilt responses SSE passthrough only for direct same-protocol responses', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      hasSseStream: true,
      continuationOwner: 'direct'
    })).toBe(true);
  });

  it('RED: rejects relay /v1/responses prebuilt SSE passthrough even when providerProtocol matches', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      hasSseStream: true,
      continuationOwner: 'relay'
    })).toBe(false);
  });

  it('RED: rejects non-direct passthrough when continuation owner is missing', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      hasSseStream: true
    })).toBe(false);
  });

  it('rejects non-responses or non-responses-protocol SSE passthrough', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-responses',
      hasSseStream: true,
      continuationOwner: 'direct'
    })).toBe(false);

    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      hasSseStream: true,
      continuationOwner: 'direct'
    })).toBe(false);
  });
});
