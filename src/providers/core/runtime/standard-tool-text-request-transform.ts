import { applyDeepSeekWebRequestTransform } from '../../../../node_modules/@jsonstudio/llms/dist/conversion/compat/actions/deepseek-web-request.js';

export type StandardToolTextRequestPayload = Record<string, unknown>;
export type StandardToolTextRequestContext = Record<string, unknown>;

/**
 * Provider-agnostic text-tool request normalization entry.
 *
 * NOTE:
 * - Current implementation reuses the existing llmswitch-core compat transformer.
 * - Keep this wrapper neutral so provider code no longer couples to DeepSeek naming.
 */
export function applyStandardToolTextRequestTransform(
  payload: StandardToolTextRequestPayload,
  adapterContext?: StandardToolTextRequestContext
): StandardToolTextRequestPayload {
  return applyDeepSeekWebRequestTransform(payload as any, adapterContext as any) as StandardToolTextRequestPayload;
}
