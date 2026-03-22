import { Readable } from "node:stream";
import type { SseProtocol } from "../../../sse/index.js";
import { defaultSseCodecRegistry } from "../../../sse/index.js";
import {
  extractModelHintFromMetadataWithNative,
  resolveSseProtocolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type { HubPipelineProviderProtocol } from "./hub-pipeline-protocol-types.js";

export interface PayloadNormalizationContext {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: HubPipelineProviderProtocol;
  metadata: Record<string, unknown>;
}

export function resolveReadablePayload(
  payload:
    | Record<string, unknown>
    | { readable?: Readable }
    | Readable
    | undefined,
): Readable | null {
  if (!payload) {
    return null;
  }
  if (payload instanceof Readable) {
    return payload;
  }
  if (payload && typeof payload === "object" && "readable" in payload) {
    const candidate = (payload as Record<string, unknown>).readable;
    if (candidate instanceof Readable) {
      return candidate;
    }
  }
  return null;
}

export async function convertSsePayloadToJson(
  stream: Readable,
  context: PayloadNormalizationContext,
): Promise<Record<string, unknown>> {
  const protocol = resolveSseProtocolWithNative(
    context.metadata,
    context.providerProtocol,
  ) as SseProtocol;
  const codec = defaultSseCodecRegistry.get(protocol);
  try {
    const result = await codec.convertSseToJson(stream, {
      requestId: context.requestId,
      model: extractModelHintFromMetadataWithNative(context.metadata),
      direction: "request",
    });
    if (!result || typeof result !== "object") {
      throw new Error("SSE conversion returned empty payload");
    }
    return result as Record<string, unknown>;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    throw new Error(
      `Failed to convert SSE payload for protocol ${protocol}: ${message}`,
    );
  }
}

export async function materializePayloadRecord(
  payload:
    | Record<string, unknown>
    | { readable?: Readable }
    | Readable
    | undefined,
  context: PayloadNormalizationContext,
  resolvedStream?: Readable | null,
): Promise<Record<string, unknown>> {
  const stream = resolvedStream ?? resolveReadablePayload(payload);
  if (stream) {
    return await convertSsePayloadToJson(stream, context);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("HubPipeline requires JSON object payload");
  }
  return payload as Record<string, unknown>;
}
