import {
  resolveHubProviderProtocolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type {
  ProviderProtocol,
} from "./hub-pipeline.js";
import { formatUnknownError } from "../../../shared/common-utils.js";

export function resolveProviderProtocolOrThrow(value: unknown): ProviderProtocol {
  try {
    return resolveHubProviderProtocolWithNative(value) as ProviderProtocol;
  } catch (error) {
    throw new Error(
      `[HubPipeline] Unsupported providerProtocol "${value}". native resolver failed: ${formatUnknownError(error)}`,
    );
  }
}
