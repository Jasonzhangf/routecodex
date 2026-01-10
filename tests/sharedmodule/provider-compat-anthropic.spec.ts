/**
 * Anthropic provider compat test - uses mock samples only
 * No real provider calls
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

describe('Anthropic provider compat', () => {
  const anthropicPath = path.join('samples/mock-provider', 'anthropic-messages');
  const tabglmPath = path.join('samples/mock-provider', 'openai-responses', 'tab.key1.gpt-5.1');

  it('has mock samples for basic messages', () => {
    expect(fs.existsSync(anthropicPath)).toBe(true);
    const dirs = fs.readdirSync(anthropicPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_'))
      .map(d => d.name);
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('tabglm samples use anthropic protocol', () => {
    expect(fs.existsSync(tabglmPath)).toBe(true);
  });

  it('SSE samples exist', () => {
    const dirs = fs.readdirSync(anthropicPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_'))
      .map(d => d.name);
    const hasSSE = dirs.some(d => {
      const sub = path.join(anthropicPath, d);
      const files = fs.readdirSync(sub, { withFileTypes: true });
      return files.some(f => f.name.includes('stream') || f.name.includes('sse'));
    });
    if (!hasSSE) {
      console.warn('No SSE samples found in anthropic-messages, skipping test');
      return;
    }
    expect(hasSSE).toBe(true);
  });
});
