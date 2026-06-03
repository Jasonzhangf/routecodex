import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

describe('Hub Pipeline TS marker strip boundary', () => {
  it('keeps chat-process generic marker strip as a native-only wrapper', () => {
    const source = readFileSync(
      resolve(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-generic-marker-strip.ts'),
      'utf8'
    );

    expect(source).toContain('cleanRoutingInstructionMarkersWithNative');
    expect(source).toContain('parseRoutingInstructionsWithNative');
    expect(source).not.toContain('marker-lifecycle');
    expect(source).not.toContain('routing-instructions/parse');
    expect(source).not.toMatch(/stripMarkerSyntaxFrom(Request|Messages|Content|Text)/);
    expect(source).not.toMatch(/source\.indexOf|replaceAll|\.replace\(/);
  });
});
