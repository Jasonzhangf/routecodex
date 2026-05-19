import type { StandardizedRequest } from "../types/standardized.js";
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import { logHubPipelineNonBlockingError } from "./hub-pipeline-runtime-hooks-blocks.js";

export function propagateApplyPatchToolModeToRequestMetadata(
  normalizedMetadata: Record<string, unknown> | undefined,
  standardizedRequest: StandardizedRequest,
): void {
  try {
    const rt = readRuntimeMetadata(
      (normalizedMetadata ?? {}) as Record<string, unknown>,
    );
    const mode = String((rt as any)?.applyPatchToolMode || "")
      .trim()
      .toLowerCase();
    if (mode === "schema") {
      (
        standardizedRequest.metadata as Record<string, unknown>
      ).applyPatchToolMode = mode;
    }
  } catch (error) {
    logHubPipelineNonBlockingError(
      "propagateApplyPatchToolModeToRequestMetadata",
      error,
    );
  }
}
