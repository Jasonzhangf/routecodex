import { applyQwenChatWebRequestTransform } from '../../../../sharedmodule/llmswitch-core/dist/conversion/compat/actions/qwenchat-web-request.js';

export type StandardToolTextRequestPayload = Record<string, unknown>;
export type StandardToolTextRequestContext = Record<string, unknown>;

export const standardToolTextRequestTransformRuntime = {
  transform(
    payload: StandardToolTextRequestPayload,
    adapterContext?: StandardToolTextRequestContext
  ): StandardToolTextRequestPayload {
    return applyQwenChatWebRequestTransform(
      payload as any,
      adapterContext as any
    ) as StandardToolTextRequestPayload;
  }
};

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
  return standardToolTextRequestTransformRuntime.transform(payload, adapterContext);
}
