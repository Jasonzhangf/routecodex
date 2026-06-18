import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('server responses SSE business module contract', () => {
  it('keeps handler-response-sse transport-only while responses-sse-bridge owns terminal semantics', () => {
    const handler = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
    const bridge = readFileSync(join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'), 'utf8');

    expect(handler).toContain("from '../../modules/llmswitch/bridge/responses-sse-bridge.js'");
    expect(bridge).toContain('// feature_id: server.responses_sse_bridge_surface');

    for (const forbiddenLocalDefinition of [
      'function inspectResponsesTerminalStateFromSseChunk(',
      'function buildResponsesTerminalSseFramesFromProbe(',
      'function planResponsesStreamEndRepair(',
      'function shouldRequireResponsesTerminalEvent(',
      'function resolveResponsesTerminalProbeFinishReason(',
      'function updateResponsesContractProbeFromSseChunk(',
      'function buildResponsesSseErrorPayload(',
      'function buildResponsesStreamIncompleteErrorPayload(',
    ]) {
      expect(handler).not.toContain(forbiddenLocalDefinition);
    }
  });

  it('locks SSE owner docs and gate wiring to the dedicated business module', () => {
    const functionMap = readFileSync(join(root, 'docs/architecture/function-map.yml'), 'utf8');
    const verificationMap = readFileSync(join(root, 'docs/architecture/verification-map.yml'), 'utf8');
    const packageJson = readFileSync(join(root, 'package.json'), 'utf8');

    expect(functionMap).toContain('feature_id: server.responses_sse_bridge_surface');
    expect(functionMap).toContain('tests/red-tests/server_responses_sse_business_module_contract.test.ts');
    expect(functionMap).toContain('npm run verify:responses-sse-business-module');

    expect(verificationMap).toContain('feature_id: server.responses_sse_bridge_surface');
    expect(verificationMap).toContain('tests/red-tests/server_responses_sse_business_module_contract.test.ts');
    expect(verificationMap).toContain('npm run verify:responses-sse-business-module');

    expect(packageJson).toContain('"verify:responses-sse-business-module"');
  });
});
