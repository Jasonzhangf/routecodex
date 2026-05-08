import type { JsonObject } from "../types/json.js";
import { jsonClone } from "../types/json.js";
import type {
  StandardizedMessage,
  StandardizedParameters,
  StandardizedRequest,
  StandardizedTool,
} from "../types/standardized.js";
import { REASONING_STOP_TOOL_DEF } from "../../../servertool/handlers/reasoning-stop-state.js";

function hasReasoningStopTool(tools: StandardizedTool[] | undefined): boolean {
  return Boolean(
    Array.isArray(tools) &&
      tools.some((tool) => {
        const name =
          tool &&
          typeof tool === "object" &&
          tool.function &&
          typeof tool.function === "object" &&
          typeof tool.function.name === "string"
            ? tool.function.name.trim().toLowerCase()
            : "";
        return name === "reasoning.stop";
      }),
  );
}

export function applyReasoningStopToolingToRequest(args: {
  request: StandardizedRequest;
  requestSnapshot: JsonObject;
  captured: JsonObject;
  preserveCapturedForFollowup: boolean;
}): void {
  const capturedMessages = (args.requestSnapshot as Record<string, unknown>).messages;
  const strippedMessages = Array.isArray(capturedMessages)
    ? (jsonClone(
        capturedMessages as unknown as JsonObject[],
      ) as unknown as StandardizedMessage[])
    : undefined;
  if (strippedMessages) {
    args.request.messages = strippedMessages;
  }

  if (!hasReasoningStopTool(args.request.tools)) {
    const nextTools = Array.isArray(args.request.tools)
      ? [...args.request.tools]
      : [];
    nextTools.push(
      jsonClone(REASONING_STOP_TOOL_DEF) as unknown as StandardizedTool,
    );
    args.request.tools = nextTools;
  }

  if (!args.preserveCapturedForFollowup) {
    (args.captured as { messages?: StandardizedMessage[] }).messages = jsonClone(
      args.request.messages as unknown as JsonObject[],
    ) as unknown as StandardizedMessage[];
    (args.captured as { tools?: StandardizedTool[] }).tools = jsonClone(
      (args.request.tools ?? []) as unknown as JsonObject[],
    ) as unknown as StandardizedTool[];
    (args.captured as { parameters?: StandardizedParameters }).parameters = jsonClone(
      args.request.parameters as unknown as JsonObject,
    ) as unknown as StandardizedParameters;
  }
}
