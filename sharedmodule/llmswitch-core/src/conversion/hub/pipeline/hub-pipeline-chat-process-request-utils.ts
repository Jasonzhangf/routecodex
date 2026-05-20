import { readRuntimeMetadata } from "../../runtime-metadata.js";
import type { StandardizedRequest } from "../types/standardized.js";
import {
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-shared.js";

export {
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
};

export function propagateApplyPatchToolModeToRequestMetadata(
  normalizedMetadata: Record<string, unknown> | undefined,
  standardizedRequest: StandardizedRequest,
): void {
  try {
    const rt = readRuntimeMetadata((normalizedMetadata ?? {}) as Record<string, unknown>);
    const mode = String((rt as any)?.applyPatchToolMode || "").trim().toLowerCase();
    if (mode === "schema") {
      (standardizedRequest.metadata as Record<string, unknown>).applyPatchToolMode = mode;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    console.warn(
      `[hub-pipeline] propagateApplyPatchToolModeToRequestMetadata failed (non-blocking): ${reason}`,
    );
  }
}
