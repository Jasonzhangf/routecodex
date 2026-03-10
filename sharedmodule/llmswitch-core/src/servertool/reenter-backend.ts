import type { JsonObject } from '../conversion/hub/types/json.js';
import { ensureRuntimeMetadata } from '../conversion/runtime-metadata.js';

export async function reenterServerToolBackend(args: {
  reenterPipeline: (options: {
    entryEndpoint: string;
    requestId: string;
    body: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ body?: JsonObject; __sse_responses?: unknown; format?: string }>;
  entryEndpoint: string;
  requestId: string;
  body: JsonObject;
  providerProtocol: string;
  routeHint?: string;
  metadata?: JsonObject;
}): Promise<{ body?: JsonObject; __sse_responses?: unknown; format?: string }> {
  const routeHint =
    typeof args.routeHint === 'string' && args.routeHint.trim().length ? args.routeHint.trim() : undefined;
  const merged: JsonObject = {
    providerProtocol: args.providerProtocol as any,
    stream: false,
    ...(routeHint ? { routeHint } : {}),
    ...(args.metadata ?? {})
  };
  const rt = ensureRuntimeMetadata(merged as unknown as Record<string, unknown>);
  (rt as Record<string, unknown>).serverToolFollowup = true;
  (rt as Record<string, unknown>).preserveRouteHint = false;
  (rt as Record<string, unknown>).disableStickyRoutes = true;
  return await args.reenterPipeline({
    entryEndpoint: args.entryEndpoint,
    requestId: args.requestId,
    body: args.body,
    metadata: merged
  });
}
