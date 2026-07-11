import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('server responses SSE business module contract', () => {
  it('keeps handler-response-sse transport-only and forbids SSE semantics in lifecycle bridge owners', () => {
    const handler = readFileSync(join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
    const nativeExports = readFileSync(join(root, 'src/modules/llmswitch/bridge/native-exports.ts'), 'utf8');

    expect(existsSync(join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'))).toBe(false);
    expect(handler).toContain("from '../../modules/llmswitch/bridge/sse-projection-host.js'");
    expect(handler).toContain('projectResponsesSseFrameForClientNative');
    expect(nativeExports).toContain('projectResponsesSseFrameForClientNative');
    expect(handler).toContain('function buildClientSseKeepaliveFrameForHttp(');
    expect(handler).not.toContain('export function shouldDropClientSseFrameForHttp(');
    expect(handler).not.toContain('shouldDropClientSseFrameForHttp');

    for (const forbiddenLocalDefinition of [
      'async function streamResponsesJsonAsSse(',
      'async function streamChatCompletionsJsonAsSse(',
      'async function dispatchResponsesJsonAsSse(',
      'function inspectResponsesTerminalStateFromSseChunk(',
      'function hasResponsesTerminalSseMarker(',
      'sawTerminalEvent',
      'terminalScanBuffer',
      'function buildStructuredSseErrorPayloadForHttp(',
      'function extractStructuredSseErrorPayload(',
      'function sendStructuredSseError(',
      'structured_error_passthrough',
      'function buildTransportLocalSseErrorPayload(',
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

    for (const forbiddenBridgeSemantic of [
      'normalizeResponsesSseFrameForClientForHttp',
      'summarizeResponsesSseFrameForLogForHttp',
      'resolveResponsesProviderProtocolHintFromSseFrameForHttp',
      'assertDirectPassthroughResponsesSseMetadataIsolationForHttp',
      'sanitizeDirectPassthroughResponsesSseFrameForHttp',
      'attachResponsesStreamSemanticsForHttp',
      'inspectResponsesTerminalStateFromSseChunkForHttp',
      'inspectResponsesContinuationProbeForHttp',
      'resolveResponsesTerminalProbeFinishReasonForHttp',
      'shouldRequireResponsesTerminalEventForHttp',
      'shouldDropClientSseFrameForHttp',
    ]) {
      expect(handler).not.toContain(forbiddenBridgeSemantic);
    }

    expect(handler).not.toContain('preparedResponsesJsonSseDispatch?.finishReason');
    expect(handler).not.toContain('bridgePlan.finishReason');
    expect(handler).not.toContain('sseCloseoutFinishReason');
    expect(handler).not.toContain('args.logResponseCompleted({');
    expect(handler).not.toContain('releaseMetadataCenterForHttpResponse(');
    expect(handler).not.toContain('buildResponsesSseErrorPayloadForHttp');
    expect(handler).not.toContain('buildResponsesStructuredSseErrorPayloadForHttp');
    expect(handler).not.toContain('buildResponsesMissingSseBridgeErrorPayloadForHttp');
    expect(handler).not.toContain('createResponsesJsonToSseConverterForHttp');
    expect(handler).not.toContain('createChatJsonToSseConverterForHttp');
    expect(handler).not.toContain('buildResponsesPayloadFromChatForHttp');
    expect(handler).not.toContain('prepareResponsesJsonBodyForSseBridgeForHttp');
    expect(handler).not.toContain('buildResponsesSseErrorPayloadForHttp');
    expect(handler).not.toContain('buildResponsesStructuredSseErrorPayloadForHttp');
    expect(handler).not.toContain('buildResponsesMissingSseBridgeErrorPayloadForHttp');
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
