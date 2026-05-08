import { markHeavyInputFastpath, shouldUseHeavyInputFastpath } from "./hub-pipeline-heavy-input-fastpath.js";

export function buildCapturedChatRequestInput(args: unknown): unknown {
  const directRequest =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;
  if (!directRequest) {
    return {};
  }

  const record = directRequest;
  const workingRequest =
    record.workingRequest && typeof record.workingRequest === "object" && !Array.isArray(record.workingRequest)
      ? (record.workingRequest as Record<string, unknown>)
      : (record.messages || record.input ? record : undefined);
  const normalizedMetadata =
    record.normalizedMetadata &&
    typeof record.normalizedMetadata === "object" &&
    !Array.isArray(record.normalizedMetadata)
      ? (record.normalizedMetadata as Record<string, unknown>)
      : undefined;

  if (normalizedMetadata && shouldUseHeavyInputFastpath(normalizedMetadata)) {
    markHeavyInputFastpath({
      metadata: normalizedMetadata,
      estimatedInputTokens: normalizedMetadata.estimatedInputTokens,
      reason: "captured_snapshot",
    });
  }

  const model =
    (typeof workingRequest?.model === "string" && String(workingRequest.model).trim()) ||
    (typeof normalizedMetadata?.model === "string" && normalizedMetadata.model.trim()) ||
    null;
  const messages = Array.isArray(workingRequest?.messages) ? workingRequest?.messages : [];
  const hasInput = Boolean(workingRequest && Object.prototype.hasOwnProperty.call(workingRequest, "input"));
  const input = hasInput ? workingRequest?.input : undefined;
  const tools = Array.isArray(workingRequest?.tools) ? workingRequest?.tools : null;
  const parameters =
    workingRequest?.parameters && typeof workingRequest.parameters === "object" && !Array.isArray(workingRequest.parameters)
      ? workingRequest.parameters
      : null;

  return {
    model,
    messages,
    ...(hasInput ? { input } : {}),
    tools,
    parameters,
  };
}
