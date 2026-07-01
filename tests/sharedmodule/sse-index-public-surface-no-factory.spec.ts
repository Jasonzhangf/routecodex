import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('SSE index public surface no factory boundary', () => {
  it('does not keep converter factories, roundTrip helpers, or default converter singletons', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/index.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('createChatConverters(');
    expect(source).not.toContain('createResponsesConverters(');
    expect(source).not.toContain('createAnthropicConverters(');
    expect(source).not.toContain('createGeminiConverters(');
    expect(source).not.toContain('async roundTrip(');
    expect(source).not.toContain('export const chatConverters =');
    expect(source).not.toContain('export const responsesConverters =');
    expect(source).not.toContain('export const anthropicConverters =');
    expect(source).not.toContain('export const geminiConverters =');
  });

  it('keeps codec registry available from the barrel', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/sse/index.js');

    expect(typeof mod.defaultSseCodecRegistry?.get).toBe('function');
    expect(typeof mod.SseCodecRegistry).toBe('function');
  });

  it('does not let runtime modules use the public SSE barrel as registry indirection', () => {
    const runtimeFiles = [
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
    ];

    for (const file of runtimeFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).not.toContain('sse/index.js');
      expect(source).toContain('sse/registry/sse-codec-registry.js');
    }
  });
});
