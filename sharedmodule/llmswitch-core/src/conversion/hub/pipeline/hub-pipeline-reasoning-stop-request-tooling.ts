import type { AdapterContext } from "../types/chat-envelope.js";
import type { StandardizedRequest } from "../types/standardized.js";
import {
  syncReasoningStopModeFromRequest,
  type ReasoningStopMode,
} from "../../../servertool/handlers/reasoning-stop-state.js";
import {
  applyReasoningStopToolingToRequest,
  backfillAdapterContextSessionIdentifiersFromRequest,
  resolveCapturedChatRequestForReasoningStop,
} from "./hub-pipeline-reasoning-stop-request-tooling-blocks.js";

export function prepareReasoningStopRequestTooling(args: {
  request: StandardizedRequest;
  adapterContext: AdapterContext;
}): ReasoningStopMode {
  backfillAdapterContextSessionIdentifiersFromRequest(
    args.request,
    args.adapterContext,
  );
  const { requestSnapshot, captured, preserveCapturedForFollowup } =
    resolveCapturedChatRequestForReasoningStop(args);
  const mode = syncReasoningStopModeFromRequest(args.adapterContext);
  if (mode === "off") {
    return mode;
  }
  applyReasoningStopToolingToRequest({
    request: args.request,
    requestSnapshot,
    captured,
    preserveCapturedForFollowup,
  });
  return mode;
}
