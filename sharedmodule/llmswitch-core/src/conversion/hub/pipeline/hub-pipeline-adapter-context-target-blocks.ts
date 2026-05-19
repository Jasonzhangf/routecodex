import type { AdapterContext } from "../types/chat-envelope.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import { isJsonObject, jsonClone } from "../types/json.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
export function applyTargetAdapterContextFields(args: {
  adapterContext: AdapterContext;
  target?: TargetMetadata;
}): void {
  const { adapterContext, target } = args;
  const targetDeepseek = isJsonObject(target?.deepseek as JsonValue | undefined)
    ? (jsonClone(target!.deepseek as JsonValue) as JsonObject)
    : undefined;
  if (targetDeepseek) {
    (adapterContext as Record<string, unknown>).deepseek = targetDeepseek;
    const rtCarrier = isJsonObject((adapterContext as Record<string, unknown>).__rt as JsonValue | undefined)
      ? ({ ...((adapterContext as Record<string, unknown>).__rt as Record<string, unknown>) } as Record<string, unknown>)
      : {};
    rtCarrier.deepseek = targetDeepseek as unknown as JsonValue;
    (adapterContext as Record<string, unknown>).__rt =
      rtCarrier as unknown as JsonValue;
  }
  if (typeof target?.anthropicThinking === "string" && target.anthropicThinking.trim()) {
    (adapterContext as Record<string, unknown>).anthropicThinking =
      target.anthropicThinking.trim().toLowerCase();
  }
  if (
    target?.anthropicThinkingConfig &&
    typeof target.anthropicThinkingConfig === "object" &&
    !Array.isArray(target.anthropicThinkingConfig)
  ) {
    (adapterContext as Record<string, unknown>).anthropicThinkingConfig = jsonClone(
      target.anthropicThinkingConfig as any,
    );
  }
  if (
    target?.anthropicThinkingBudgets &&
    typeof target.anthropicThinkingBudgets === "object" &&
    !Array.isArray(target.anthropicThinkingBudgets)
  ) {
    (adapterContext as Record<string, unknown>).anthropicThinkingBudgets = jsonClone(
      target.anthropicThinkingBudgets as any,
    );
  }
  if (target?.compatibilityProfile && typeof target.compatibilityProfile === "string") {
    (adapterContext as Record<string, unknown>).compatibilityProfile =
      target.compatibilityProfile;
  }
  if (typeof target?.supportsMultimodal === "boolean") {
    const rtCarrier = isJsonObject((adapterContext as Record<string, unknown>).__rt as JsonValue | undefined)
      ? ({ ...((adapterContext as Record<string, unknown>).__rt as Record<string, unknown>) } as Record<string, unknown>)
      : {};
    rtCarrier.supportsMultimodal = target.supportsMultimodal;
    (adapterContext as Record<string, unknown>).__rt =
      rtCarrier as unknown as JsonValue;
  }
}
