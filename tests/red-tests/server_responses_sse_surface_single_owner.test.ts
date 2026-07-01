import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('server responses SSE surface single owner', () => {
  it('keeps handler-response-sse transport-only without lifecycle facade imports', () => {
    const source = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
    const importStatements = source
      .split('\n')
      .filter((line) => line.startsWith('import ') || line.startsWith('} from '));
    const joinedImports = importStatements.join('\n');

    expect(source).toContain("from '../../modules/llmswitch/bridge/responses-sse-bridge.js'");
    expect(source).not.toContain('responses-client-projection');
    expect(source).not.toContain('responses-stream-semantics');
    expect(joinedImports).not.toMatch(/buildResponsesSseErrorPayloadForHttp[\s\S]*responses-response-bridge\.js/);
    expect(joinedImports).not.toMatch(/shouldDispatchResponsesSseToClientForHttp[\s\S]*responses-response-bridge\.js/);
    expect(joinedImports).not.toMatch(/resolveResponsesRequestContextForHttp[\s\S]*responses-response-bridge\.js/);
    expect(source).not.toContain('persistResponsesConversationLifecycleForHttp');
    expect(source).not.toContain('planResponsesContinuationCloseActionForHttp');
  });

  it('keeps handler-response-utils transport-only without continuation save owner', () => {
    const source = readFileSync(join(root, 'src/server/handlers/handler-response-utils.ts'), 'utf8');

    expect(source).toContain("from '../../modules/llmswitch/bridge/responses-response-bridge.js'");
    expect(source).not.toContain('persistResponsesConversationLifecycleForHttp');
  });

  it('does not re-export SSE bridge symbols from the lifecycle bridge index section', () => {
    const source = readFileSync(join(root, 'src/modules/llmswitch/bridge/index.ts'), 'utf8');
    const lifecycleSection = source.split("} from './responses-response-bridge.js';")[0]?.split("export {\n  resolveResponsesConversationClearReasonForHttp")[1] ?? '';

    expect(source).toContain("from './responses-sse-bridge.js'");
    expect(lifecycleSection).not.toContain('buildResponsesSseErrorPayloadForHttp');
    expect(lifecycleSection).not.toContain('buildResponsesStructuredSseErrorPayloadForHttp');
    expect(lifecycleSection).not.toContain('buildResponsesMissingSseBridgeErrorPayloadForHttp');
    expect(lifecycleSection).not.toContain('shouldDispatchResponsesSseToClientForHttp');
    expect(lifecycleSection).not.toContain('resolveResponsesRequestContextForHttp');
  });

  it('does not let responses-response-bridge own SSE semantic helpers', () => {
    const source = readFileSync(join(root, 'src/modules/llmswitch/bridge/responses-response-bridge.ts'), 'utf8');

    for (const forbiddenExport of [
      'export function inspectResponsesTerminalStateFromSseChunkForHttp(',
      'export function inspectResponsesContinuationProbeForHttp(',
      'export function planResponsesStreamEndRepairForHttp(',
      'export function resolveResponsesTerminalProbeFinishReasonForHttp(',
      'export function shouldRequireResponsesTerminalEventForHttp(',
      'export async function createResponsesJsonToSseConverterForHttp(',
      'export async function projectResponsesSseFrameForClientForHttp(',
      'export async function normalizeResponsesSseFrameForClientForHttp(',
    ]) {
      expect(source).not.toContain(forbiddenExport);
    }
  });

  it('physically deletes old SSE semantic owners', () => {
    const bridgeSource = readFileSync(join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'), 'utf8');
    const indexSource = readFileSync(join(root, 'src/modules/llmswitch/bridge/index.ts'), 'utf8');

    expect(bridgeSource).not.toContain('responses-sse-semantics');
    expect(bridgeSource).not.toContain('responses-client-projection');
    expect(bridgeSource).not.toContain('buildResponsesSseErrorPayloadForHttp');
    expect(bridgeSource).not.toContain('buildResponsesStructuredSseErrorPayloadForHttp');
    expect(bridgeSource).not.toContain('buildResponsesMissingSseBridgeErrorPayloadForHttp');
    expect(indexSource).not.toContain('normalizeResponsesSseFrameForClientForHttp');
    expect(indexSource).not.toContain('projectResponsesSseFrameForClientForHttp');
    expect(indexSource).not.toContain('assertDirectPassthroughResponsesSseMetadataIsolationForHttp');
  });

  it('keeps responses-sse-bridge limited to SSE transport exports', () => {
    const bridgeSource = readFileSync(join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'), 'utf8');

    expect(bridgeSource).not.toContain('buildResponsesRequestLogContextForHttp');
    expect(bridgeSource).not.toContain('prepareResponsesJsonClientDispatchPlanForHttp');
    expect(bridgeSource).not.toContain('importResponsesHandlerCoreDist');
    expect(bridgeSource).not.toContain('requireResponsesHandlerCoreDist');
    expect(bridgeSource).not.toContain('ResponsesRequestContextForHttp');
  });
});
