import {
  runHubPipelineOrchestrationWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";

export function runNormalizedRequestOrchestration(args: {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stream: boolean;
  processMode: "chat" | "passthrough";
  direction: "request" | "response";
  stage: "inbound" | "outbound";
}): {
  payload: Record<string, unknown>;
  orchestrationMetadata: Record<string, unknown>;
} {
  const orchestrationResult = runHubPipelineOrchestrationWithNative({
    requestId: args.requestId,
    endpoint: args.endpoint,
    entryEndpoint: args.entryEndpoint,
    providerProtocol: args.providerProtocol,
    payload: args.payload,
    metadata: args.metadata,
    stream: args.stream,
    processMode: args.processMode,
    direction: args.direction,
    stage: args.stage,
  });
  if (!orchestrationResult.success) {
    const code =
      orchestrationResult.error &&
      typeof orchestrationResult.error.code === "string"
        ? orchestrationResult.error.code.trim()
        : "hub_pipeline_native_failed";
    const message =
      orchestrationResult.error &&
      typeof orchestrationResult.error.message === "string"
        ? orchestrationResult.error.message.trim()
        : "Native hub pipeline orchestration failed";
    throw new Error(`[${code}] ${message}`);
  }
  return {
    payload: orchestrationResult.payload ?? args.payload,
    orchestrationMetadata:
      orchestrationResult.metadata &&
      typeof orchestrationResult.metadata === "object" &&
      !Array.isArray(orchestrationResult.metadata)
        ? (orchestrationResult.metadata as Record<string, unknown>)
        : {},
  };
}
