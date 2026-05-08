import type { AdapterContext } from "../types/chat-envelope.js";
import type { JsonObject } from "../types/json.js";
import { jsonClone } from "../types/json.js";
import type { StandardizedRequest } from "../types/standardized.js";

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readSessionLikeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function backfillAdapterContextSessionIdentifiersFromRequest(
  request: StandardizedRequest,
  adapterContext: AdapterContext,
): void {
  const adapterRecord = adapterContext as Record<string, unknown>;
  const requestMetadata =
    request.metadata && typeof request.metadata === "object"
      ? (request.metadata as Record<string, unknown>)
      : undefined;
  if (!requestMetadata) {
    return;
  }

  const sessionId =
    readSessionLikeToken(adapterRecord.sessionId) ??
    readSessionLikeToken(requestMetadata.sessionId) ??
    readSessionLikeToken(requestMetadata.session_id);
  const conversationId =
    readSessionLikeToken(adapterRecord.conversationId) ??
    readSessionLikeToken(requestMetadata.conversationId) ??
    readSessionLikeToken(requestMetadata.conversation_id);

  if (sessionId && !readSessionLikeToken(adapterRecord.sessionId)) {
    adapterRecord.sessionId = sessionId;
  }
  if (
    conversationId &&
    !readSessionLikeToken(adapterRecord.conversationId)
  ) {
    adapterRecord.conversationId = conversationId;
  }
}

export function resolveCapturedChatRequestForReasoningStop(args: {
  request: StandardizedRequest;
  adapterContext: AdapterContext;
}): {
  requestSnapshot: JsonObject;
  captured: JsonObject;
  preserveCapturedForFollowup: boolean;
} {
  const requestSnapshot: JsonObject = {
    model: args.request.model,
    messages: jsonClone(
      args.request.messages as unknown as JsonObject[],
    ) as unknown as JsonObject,
  };
  if (Array.isArray(args.request.tools)) {
    requestSnapshot.tools = jsonClone(
      args.request.tools as unknown as JsonObject[],
    ) as unknown as JsonObject;
  }
  if (args.request.parameters && typeof args.request.parameters === "object") {
    requestSnapshot.parameters = jsonClone(
      args.request.parameters as unknown as JsonObject,
    );
  }

  const rt = asFlatRecord((args.adapterContext as Record<string, unknown>).__rt);
  const captured = asFlatRecord(
    (args.adapterContext as Record<string, unknown>).capturedChatRequest,
  );
  const preserveCapturedForFollowup =
    rt?.serverToolFollowup === true &&
    Boolean(
      captured && (Array.isArray(captured.messages) || Array.isArray(captured.input)),
    );
  const resolvedCaptured = preserveCapturedForFollowup
    ? (captured as JsonObject)
    : requestSnapshot;
  if (!preserveCapturedForFollowup) {
    (args.adapterContext as Record<string, unknown>).capturedChatRequest =
      resolvedCaptured;
  }
  return {
    requestSnapshot,
    captured: resolvedCaptured,
    preserveCapturedForFollowup,
  };
}
