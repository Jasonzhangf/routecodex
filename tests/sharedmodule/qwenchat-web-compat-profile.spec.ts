import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadProfile(file: string): Record<string, unknown> {
  const path = resolve(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/compat/profiles', file);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('qwenchat-web compat profile', () => {
  it('reuses deepseek-web text-tool skeleton actions', () => {
    const deepseek = loadProfile('chat-deepseek-web.json');
    const qwenchat = loadProfile('chat-qwenchat-web.json');

    const deepseekRequest = (deepseek.request as { mappings?: unknown[] } | undefined)?.mappings ?? [];
    const qwenchatRequest = (qwenchat.request as { mappings?: unknown[] } | undefined)?.mappings ?? [];
    const deepseekResponse = (deepseek.response as { mappings?: unknown[] } | undefined)?.mappings ?? [];
    const qwenchatResponse = (qwenchat.response as { mappings?: unknown[] } | undefined)?.mappings ?? [];

    expect(qwenchat.id).toBe('chat:qwenchat-web');
    expect(qwenchatRequest).toEqual(deepseekRequest);
    expect(qwenchatResponse).toEqual(deepseekResponse);
  });
});
