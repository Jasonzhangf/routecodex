import { setVirtualRouterPolicyRuntimeRouterHooks } from "../../../router/virtual-router/provider-runtime-ingress.js";
import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig } from "./hub-pipeline.js";
import { formatUnknownError } from "../../../shared/common-utils.js";

export function logHubPipelineNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const suffix =
    details && Object.keys(details).length > 0
      ? ` details=${formatUnknownError(details)}`
      : "";
  console.warn(
    `[hub-pipeline] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`,
  );
}

export function registerProviderRuntimeHooks(args: {
  owner: unknown;
  routerEngine: VirtualRouterEngine;
}): void {
  try {
    setVirtualRouterPolicyRuntimeRouterHooks(args.owner, {
      handleProviderError: (event) => {
        try {
          args.routerEngine.handleProviderError(event);
        } catch (subscriberError) {
          logHubPipelineNonBlockingError(
            "provider-runtime-ingress.handleProviderError",
            subscriberError,
          );
        }
      },
      handleProviderSuccess: (event) => {
        try {
          args.routerEngine.handleProviderSuccess(event);
        } catch (subscriberError) {
          logHubPipelineNonBlockingError(
            "provider-runtime-ingress.handleProviderSuccess",
            subscriberError,
          );
        }
      },
    });
  } catch (hookError) {
    logHubPipelineNonBlockingError(
      "provider-runtime-ingress.register",
      hookError,
    );
  }
}

export function unregisterProviderRuntimeHooks(owner: unknown): void {
  try {
    setVirtualRouterPolicyRuntimeRouterHooks(owner, undefined);
  } catch (disposeError) {
    logHubPipelineNonBlockingError(
      "dispose.provider-runtime-ingress.unregister",
      disposeError,
    );
  }
}

export function updateRouterRuntimeDeps(args: {
  deps: {
    healthStore?: HubPipelineConfig["healthStore"] | null;
    routingStateStore?: HubPipelineConfig["routingStateStore"] | null;
    quotaView?: HubPipelineConfig["quotaView"] | null;
  };
  config: HubPipelineConfig;
  routerEngine: VirtualRouterEngine;
}): void {
  const { deps, config, routerEngine } = args;
  if (!deps || typeof deps !== "object") {
    return;
  }
  if ("healthStore" in deps) {
    config.healthStore = deps.healthStore ?? undefined;
  }
  if ("routingStateStore" in deps) {
    config.routingStateStore = (deps.routingStateStore ?? undefined) as any;
  }
  if ("quotaView" in deps) {
    config.quotaView = deps.quotaView ?? undefined;
  }
  try {
    routerEngine.updateDeps({
      healthStore: config.healthStore ?? null,
      routingStateStore: (config.routingStateStore ?? null) as any,
      quotaView: config.quotaView ?? null,
    });
  } catch (updateDepsError) {
    logHubPipelineNonBlockingError(
      "updateRuntimeDeps.routerEngine.updateDeps",
      updateDepsError,
    );
  }
}
