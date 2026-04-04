import { applyQwenChatWebRequestTransform } from '../../../../sharedmodule/llmswitch-core/src/conversion/compat/actions/qwenchat-web-request.js';

export type StandardToolTextRequestPayload = Record<string, unknown>;
export type StandardToolTextRequestContext = Record<string, unknown>;

/**
 * Provider-agnostic text-tool request normalization entry.
 *
 * NOTE:
 * - Current implementation reuses the qwenchat-web compat profile in llmswitch-core.
 * - Keep this wrapper neutral so provider code no longer couples to DeepSeek naming.
 */
export function applyStandardToolTextRequestTransform(
  payload: StandardToolTextRequestPayload,
  adapterContext?: StandardToolTextRequestContext
): StandardToolTextRequestPayload {
  return applyQwenChatWebRequestTransform(
    payload as any,
    adapterContext as any
  ) as StandardToolTextRequestPayload;
}
