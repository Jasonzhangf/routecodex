import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldAllowDirectResponsesPrebuiltSsePassthrough } from '../../../../../src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sharedBlocksSourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts'
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
