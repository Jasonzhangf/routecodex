import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('server responses SSE surface single owner', () => {
  it('keeps handler-response-sse transport-only without lifecycle facade imports', () => {
    const source = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
    const importStatements = source
      .split('\n')
      .filter((line) => line.startsWith('import ') || line.startsWith('} from '));
    const joinedImports = importStatements.join('\n');

    expect(source).toContain("from '../../modules/llmswitch/bridge/native-exports.js'");
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

    expect(source).toContain('planResponsesJsonClientDispatchNative');
    expect(source).not.toContain('persistResponsesConversationLifecycleForHttp');
  });

  it('keeps the broad bridge index barrel physically deleted', () => {
    expect(existsSync(join(root, 'src/modules/llmswitch/bridge/index.ts'))).toBe(false);
  });

  it('keeps duplicate response bridge facade deleted', () => {
    expect(existsSync(join(root, 'src/modules/llmswitch/bridge/responses-response-bridge.ts'))).toBe(false);
  });

  it('does not let handler SSE own response bridge semantic helpers', () => {
    const source = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');

    for (const forbiddenExport of [
      'inspectResponsesTerminalStateFromSseChunkForHttp',
      'inspectResponsesContinuationProbeForHttp',
      'planResponsesStreamEndRepairForHttp',
      'resolveResponsesTerminalProbeFinishReasonForHttp',
      'shouldRequireResponsesTerminalEventForHttp',
      'createResponsesJsonToSseConverterForHttp',
      'projectResponsesSseFrameForClientForHttp',
      'normalizeResponsesSseFrameForClientForHttp',
    ]) {
      expect(source).not.toContain(forbiddenExport);
    }
  });

  it('physically deletes old SSE semantic owners', () => {
    const handlerSource = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');

    expect(existsSync(join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'))).toBe(false);
    expect(handlerSource).toContain('projectResponsesSseFrameForClientNative');
    expect(handlerSource).not.toContain('export function projectResponsesSseFrameForClientForHttp(');
    expect(handlerSource).not.toContain('responses-sse-semantics');
    expect(handlerSource).not.toContain('responses-client-projection');
    expect(handlerSource).not.toContain('buildResponsesSseErrorPayloadForHttp');
    expect(handlerSource).not.toContain('buildResponsesStructuredSseErrorPayloadForHttp');
    expect(handlerSource).not.toContain('buildResponsesMissingSseBridgeErrorPayloadForHttp');
  });

  it('keeps deleted SSE bridge surface from reappearing in handler', () => {
    const handlerSource = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');

    expect(handlerSource).not.toContain('buildResponsesRequestLogContextForHttp');
    expect(handlerSource).not.toContain('prepareResponsesJsonClientDispatchPlanForHttp');
    expect(handlerSource).not.toContain('importResponsesHandlerCoreDist');
    expect(handlerSource).not.toContain('requireResponsesHandlerCoreDist');
    expect(handlerSource).not.toContain('ResponsesRequestContextForHttp');
  });
});
