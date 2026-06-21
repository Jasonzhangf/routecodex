import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('server-side-tools response-stage gate guard', () => {
  test('runServerSideToolEngine routes empty-assistant bypass through native response-stage gate', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts',
      'utf8'
    );

    expect(source).not.toContain('detectEmptyAssistantPayloadContractSignalWithNative');
    expect(source).not.toContain('isStopEligibleForServerTool');
    expect(source).toContain('respStageGateNative(');
  });
});
