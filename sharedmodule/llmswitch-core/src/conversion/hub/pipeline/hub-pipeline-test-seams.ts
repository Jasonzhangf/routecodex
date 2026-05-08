import type { AdapterContext } from "../types/chat-envelope.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { NormalizedRequest } from "./hub-pipeline-types.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";

export function __unsafeBuildAdapterContextForTest(
  normalized: NormalizedRequest,
  target?: TargetMetadata,
): AdapterContext {
  return buildAdapterContextFromNormalized(normalized, target);
}
