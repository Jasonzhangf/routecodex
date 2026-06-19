import type { JsonObject } from '../conversion/hub/types/json.js';

export async function reenterServerToolBackend(args: {
  reenterPipeline: (options: {
    entryEndpoint: string;
    requestId: string;
    body: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ body?: JsonObject; sseStream?: unknown; format?: string }>;
  entryEndpoint: string;
  requestId: string;
  body: JsonObject;
  providerProtocol: string;
  routeHint?: string;
  metadata?: JsonObject;
}): Promise<{ body?: JsonObject; sseStream?: unknown; format?: string }> {
  const routeHint =
    typeof args.routeHint === 'string' && args.routeHint.trim().length ? args.routeHint.trim() : undefined;
  const merged: JsonObject = {
    providerProtocol: args.providerProtocol as any,
    ...(routeHint ? { routeHint } : {}),
    ...(args.metadata ?? {})
  };
  return await args.reenterPipeline({
    entryEndpoint: args.entryEndpoint,
    requestId: args.requestId,
    body: args.body,
    metadata: merged
  });
}
