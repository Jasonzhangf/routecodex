import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sseRoot = path.join(root, 'sharedmodule/llmswitch-core/src/sse');

function listRuntimeSources(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

describe('SSE no silent failure boundary', () => {
  it('rejects explicit silent failure markers in SSE runtime sources', () => {
    const forbidden = [
      '/* noop */',
      '/* ignore */',
      'Never throw from non-blocking logging',
      'non-blocking',
      'logChatJsonToSseNonBlocking',
      'catch {}',
      '} catch {',
      'fallbackCode',
      'fallbackMessage',
      "const et = (event && (event.event || event.type)) || 'unknown'",
    ];
    const hits: string[] = [];

    for (const file of listRuntimeSources(sseRoot)) {
      const relPath = path.relative(root, file).split(path.sep).join('/');
      const source = fs.readFileSync(file, 'utf8');
      for (const marker of forbidden) {
        if (source.includes(marker)) {
          hits.push(`${relPath}: ${marker}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
