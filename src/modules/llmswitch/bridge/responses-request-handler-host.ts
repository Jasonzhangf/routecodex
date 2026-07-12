/**
 * Responses request handler native bridge surface.
 *
 * Request-side handler semantics remain Rust-owned; this host only exposes the
 * narrow native calls used by the /v1/responses HTTP request bridge.
 */

export {
  buildResponsesConversationPortScopeForHttpNative,
  buildResponsesResumeClientErrorForHttpNative,
  buildResponsesResumeControlForContinuationContextForHttpNative,
  buildResponsesScopeContinuationExpiredErrorForHttpNative,
  captureReqInboundResponsesContextSnapshotJson,
  extractSessionIdentifiersFromMetadataNative,
  finalizeResponsesHandlerPayloadForHttpNative,
  materializeProviderOwnedSubmitContext,
  planResponsesContinuationRequestAction,
  planResponsesHandlerEntry,
  planResponsesHandlerStreamForHttpNative,
  planResponsesRequestBodyForHttpNative,
  planResponsesRequestContext,
  shouldManageResponsesConversationForHttpNative,
  shouldProjectResponsesResumeClientErrorForHttpNative,
} from './native-exports.js';
