import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

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
      'clearResponsesConversationByRequestIdForHttp(',
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
    allowedImport: '../../modules/llmswitch/bridge/responses-response-bridge.js',
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
      'deriveFinishReason(args.result.body)',
      'const jsonFinishReason = deriveFinishReason(clientBody);',
      'const normalizedJsonBody = await normalizeResponsesClientPayloadForHttp(',
      "reason: 'sse-stream-error'",
      "reason: 'sse-incomplete'",
      "reason: 'json-empty-error'",
      "reason: 'json-error'",
      'status >= 400',
      'function summarizeSseFrameForLog(',
      'function resolveProviderProtocolHintFromSseFrame(',
      'function isResponsesJsonBody(',
      'function isChatCompletionJsonBody(',
      'const hasResponsesToolCallContinuationProbe =',
      'const hasResponsesRequiredActionContinuationProbe =',
      "'SSE stream missing from pipeline result'",
      "'sse_bridge_error'",
      "'stream closed before response.completed'",
      "'upstream_stream_incomplete'",
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
];

const failures = [];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const check of checks) {
  const abs = path.join(root, check.file);
  const source = fs.readFileSync(abs, 'utf8');
  if (!source.includes(check.allowedImport)) {
    failures.push(`${check.file}: missing required single-surface import ${check.allowedImport}`);
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
console.log('- /v1/responses handler request/response layers use a single facade per side');
