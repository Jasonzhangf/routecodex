import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('responses-response-bridge request-context resolution', () => {
  it('does not keep request-context salvage helpers in the response bridge surface', () => {
    const responseBridge = readFileSync(
      join(root, 'src/modules/llmswitch/bridge/responses-response-bridge.ts'),
      'utf8'
    );
    const sseBridge = readFileSync(
      join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'),
      'utf8'
    );
    const bridgeIndex = readFileSync(join(root, 'src/modules/llmswitch/bridge/index.ts'), 'utf8');

    for (const forbidden of [
      'resolveResponsesRequestContextForHttp',
      'shouldDispatchResponsesSseToClientForHttp',
    ]) {
      expect(responseBridge).not.toContain(forbidden);
      expect(sseBridge).not.toContain(forbidden);
      expect(bridgeIndex).not.toContain(forbidden);
    }

    expect(responseBridge).not.toContain('buildClientSseKeepaliveFrameForHttp');
    expect(bridgeIndex).not.toContain('resolveResponsesRequestContextForHttp');
    expect(bridgeIndex).not.toContain('shouldDispatchResponsesSseToClientForHttp');
    expect(sseBridge).toContain('buildClientSseKeepaliveFrameForHttp');
  });
});
