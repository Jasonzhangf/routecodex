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

  it('codec registry was removed from barrel during SSE rustification', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/sse/index.js');

    expect(mod.defaultSseCodecRegistry).toBeUndefined();
    expect(mod.SseCodecRegistry).toBeUndefined();
  });

  it('deleted runtime TS surfaces stay absent from SSE registry indirection path', () => {
    const deletedRuntimeFiles = [
      path.join('sharedmodule/llmswitch-core/src/conversion/hub/pipeline', 'hub-pipeline' + '.ts'),
      path.join('sharedmodule/llmswitch-core/src/conversion/hub/response', 'provider-response' + '.ts'),
    ];

    for (const file of deletedRuntimeFiles) {
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(false);
    }
  });
});
