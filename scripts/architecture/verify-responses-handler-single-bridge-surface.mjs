import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const staleHandlerProjectionSpec = 'tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts';
const staleHandlerTerminalRepairSpec = 'tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts';
const staleSseBridge = 'src/modules/llmswitch/bridge/responses-sse-bridge.ts';
const staleResponseBridge = 'src/modules/llmswitch/bridge/responses-response-bridge.ts';

if (fs.existsSync(path.join(root, staleHandlerProjectionSpec))) {
  console.error('[verify:responses-handler-single-bridge-surface] failed');
  console.error(`- stale handler-side apply_patch SSE projection spec must stay deleted: ${staleHandlerProjectionSpec}`);
  process.exit(1);
}

if (fs.existsSync(path.join(root, staleHandlerTerminalRepairSpec))) {
  console.error('[verify:responses-handler-single-bridge-surface] failed');
  console.error(`- stale handler-side Responses terminal repair spec must stay deleted: ${staleHandlerTerminalRepairSpec}`);
  process.exit(1);
}

if (fs.existsSync(path.join(root, staleSseBridge))) {
  console.error('[verify:responses-handler-single-bridge-surface] failed');
  console.error(`- duplicate SSE bridge facade must stay deleted: ${staleSseBridge}`);
  process.exit(1);
}

if (fs.existsSync(path.join(root, staleResponseBridge))) {
  console.error('[verify:responses-handler-single-bridge-surface] failed');
  console.error(`- duplicate response bridge facade must stay deleted: ${staleResponseBridge}`);
  process.exit(1);
}

const checks = [
  {
    file: 'src/server/handlers/responses-handler.ts',
    allowedImport: '../../modules/llmswitch/bridge/responses-request-bridge.js',
    forbiddenLocalTokens: [
      'payload.stream = true',
      'applySystemPromptOverride(',
      'function readResponsesSessionId(',
      'function readResponsesConversationId(',
      'function shouldPersistResponsesConversation(',
      'function shouldPersistResponsesConversationForEndpoint(',
      'function readResponsesResponseId(',
      'function normalizeResponsesJsonBody(',
      "'responses_continuation_expired'",
      "type: 'invalid_request_error'",
      "origin === 'client'",
      "responseIdFromPath && !payload.response_id",
      "pipelineEntryEndpoint === '/v1/responses'",
      "pipelineEntryEndpoint === '/v1/responses.submit_tool_outputs'",
      'Tool history contract violated',
      'toolHistoryContractViolation',
      'responses.inbound_tool_history_contract',
      'queueInboundToolHistoryErrorsample(',
      'clearResponsesConversationByRequestIdForHttp(',
      'res.write(`event: error',
      'attachResponsesRequestContextToResultForHttp(',
      'captureResponsesRequestContextForHttp(',
      'shouldManageResponsesConversationForHttp(',
      'const originalStream =',
      'const outboundStream =',
      'const inboundStream =',
      'function buildResponsesConversationPortScope(',
      'buildResponsesScopeContinuationExpiredErrorForHttp(',
      'planResponsesResumeErrorForHttp(',
      "providerProtocol: 'openai-responses'",
      'responsesResume:',
      'responsesRequestContext,',
      'readRequestBodyMetadata(',
      'stripRequestBodyMetadataForPipeline(',
      'clientAbortSignal: (() => {',
    ],
    forbiddenTokens: [
      'planResponsesHandlerEntry',
      'resumeResponsesConversation',
      'materializeLatestResponsesContinuationByScope',
      'captureResponsesRequestContextForRequest',
      'recordResponsesResponseForRequest',
      'clearResponsesConversationByRequestId',
    ],
  },
  {
    file: 'src/server/handlers/handler-response-utils.ts',
    allowedImport: '../../modules/llmswitch/bridge/responses-client-projection-host.js',
    requiredImports: [
      './handler-response-sse.js',
      './handler-response-common.js',
    ],
    forbiddenLocalTokens: [
      'RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS',
      'isResponsesRequiredActionFrame(',
      'isDirectPassthroughTransportKeepaliveFrame(',
      'buildClientSseKeepaliveFrame(',
      'shouldDropClientSseFrame(',
      'cleanupAbandonedResponsesConversation(',
      'resolveResponsesConversationRecordRequestIds(',
      'readResponsesConversationResponseId(',
      'recordResponsesConversationToolCallResponse(',
      'captureResponsesConversationToolCallRequestContext(',
      'finalizeResponsesConversationNonToolResponse(',
      'shouldPersistResponsesToolCallContinuationRecord(',
      'function updateSseTerminalTrackerFromChunk(',
      'function buildResponsesTerminalSseFramesFromProbe(',
      'const readResponsesContinuationProbeState =',
      'const resolveTerminalProbeFinishReason =',
      'async function resolveResponsesJsonSseBridgePayload(',
      'function resolveNormalizedChatUsage(',
      'function normalizeChatUsagePayload(',
      'function buildRequestLogContext(',
      'deriveFinishReason(args.result.body)',
      'const jsonFinishReason = deriveFinishReason(clientBody);',
      'preparedResponsesJsonSseDispatch?.finishReason',
      'bridgePlan.finishReason',
      "reason: 'sse-stream-error'",
      "reason: 'sse-incomplete'",
      "reason: 'json-empty-error'",
      "reason: 'json-error'",
      'status >= 400',
      'function summarizeSseFrameForLog(',
      'function resolveProviderProtocolHintFromSseFrame(',
      'export function hasSsePayload(',
      'function shouldDispatchSseToClient(',
      '?? options?.responsesRequestContext',
      'function isResponsesJsonBody(',
      'function isChatCompletionJsonBody(',
      'function createClientVisibleSseProjectionStream(',
      'function createDirectPassthroughSseGuardStream(',
      'function isInternalMetadataCarrier(',
      'function assertDirectPassthroughSseFrameHasNoInternalMetadataControls(',
      'function sendSseBridgeError(',
      'function sendStructuredSseError(',
      'function withSseClientProjectionTimeout(',
      'function createClientSseSnapshotRecorder(',
      'function maybeAttachClientSseSnapshotStream(',
      'function writeSseDiagnosticSnapshot(',
      'function logSseClientCloseDiagnosis(',
      'function hasResponsesTerminalSseMarker(',
      'function shouldProjectClientSseFrame(',
      'sawTerminalEvent',
      'terminalScanBuffer',
      'const hasResponsesToolCallContinuationProbe =',
      'const hasResponsesRequiredActionContinuationProbe =',
      "'SSE stream missing from pipeline result'",
      "'sse_bridge_error'",
      "'stream closed before response.completed'",
      "'upstream_stream_incomplete'",
      'response.sse.stream.start',
      'response.sse.client_close',
      'response.sse.terminal.write_frame',
      '?? args.responsesRequestContext',
    ],
    forbiddenTokens: [
      'buildResponsesTerminalSseFramesFromProbeNative',
      'captureResponsesRequestContextForRequest',
      'clearResponsesConversationByRequestId',
      'createResponsesJsonToSseConverter',
      'finalizeResponsesConversationRequestRetention',
      'importCoreDist',
      'isToolCallContinuationResponseNative',
      'recordResponsesResponseForRequest',
      'rebindResponsesConversationRequestId',
      'requireCoreDist',
      'updateResponsesContractProbeFromSseChunkNative',
    ],
  },
  {
    file: 'src/server/handlers/handler-response-sse.ts',
    allowedImport: '../../modules/llmswitch/bridge/sse-projection-host.js',
    requiredImports: [],
    forbiddenLocalTokens: [
      "from '../utils/finish-reason.js'",
      "projectSseErrorEventPayload",
      "from '../runtime/http-server/session-execution-state.js'",
      'getSessionExecutionStateTracker(',
      'shouldDropClientSseFrameForHttp(frame, entryEndpoint)',
      'args.logResponseCompleted({',
      'releaseMetadataCenterForHttpResponse(',
      'deriveFinishReason(',
      'function hasResponsesTerminalSseMarker(',
      'sawTerminalEvent',
      'terminalScanBuffer',
      'function buildStructuredSseErrorPayloadForHttp(',
      'function extractStructuredSseErrorPayload(',
      'function sendStructuredSseError(',
      'function buildMissingSseBridgeErrorPayloadForHttp(',
      'structured_error_passthrough',
      'function buildTransportLocalSseErrorPayload(',
      'result.usageLogInfo?.finishReason',
      'bridgePlan.finishReason',
      'sseCloseoutFinishReason',
      'responsesSseObservedTerminal',
      'responsesSseTransportState',
      'function updateResponsesTerminalProbeFromTransportText(',
      "'upstream_stream_incomplete'",
      "'SSE stream ended before response.completed'",
      "'response.sse.stream.incomplete'",
      'shouldProjectClientSseFrame(parsed.eventName)',
      'function projectResponsesSseFrameForClientForHttp(',
      'function updateResponsesSseTransportTerminalStateForHttp(',
    ],
    forbiddenTokens: [],
  },
];

const failures = [];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const check of checks) {
  const abs = path.join(root, check.file);
  const source = fs.readFileSync(abs, 'utf8');
  if (check.allowedImport && !source.includes(check.allowedImport)) {
    failures.push(`${check.file}: missing required single-surface import ${check.allowedImport}`);
  }
  for (const requiredImport of check.requiredImports ?? []) {
    if (!source.includes(requiredImport)) {
      failures.push(`${check.file}: missing required import ${requiredImport}`);
    }
  }
  for (const token of check.forbiddenLocalTokens ?? []) {
    if (source.includes(token)) {
      failures.push(`${check.file}: forbidden local/server token ${token}`);
    }
  }
  for (const token of check.forbiddenTokens) {
    const directBridgeImportPattern = new RegExp(
      String.raw`import\s*\{[^}]*${escapeRegExp(token)}[^}]*\}\s*from\s*['"]\.\.\/\.\.\/modules\/llmswitch\/bridge(?:\/index)?\.js['"]`,
      'm'
    );
    if (directBridgeImportPattern.test(source)) {
      failures.push(`${check.file}: forbidden direct bridge import ${token}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-handler-single-bridge-surface] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:responses-handler-single-bridge-surface] ok');
console.log('- /v1/responses SSE transport has no duplicate TS bridge facade; Rust/NAPI remains semantic owner');
