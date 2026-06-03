import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type PipelineContractHelp = Record<string, unknown>;

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function parseObjectPayload(capability: string, raw: unknown): PipelineContractHelp {
  if (typeof raw !== 'string' || !raw) {
    return failNativeRequired(capability, 'empty result');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failNativeRequired(capability, 'invalid payload');
  }
  return parsed as PipelineContractHelp;
}

function invokeContractHelp(capability: string, args: unknown[] = []): PipelineContractHelp {
  if (isNativeDisabledByEnv()) {
    return failNativeRequired(capability, 'native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired(capability);
  }
  try {
    return parseObjectPayload(capability, fn(...args));
  } catch (error) {
    return failNativeRequired(
      capability,
      error instanceof Error ? error.message : String(error ?? 'unknown')
    );
  }
}

export function describeHubPipelineContractsWithNative(): PipelineContractHelp {
  return invokeContractHelp('describeHubPipelineContractsJson');
}

export function describeVirtualRouterContractsWithNative(): PipelineContractHelp {
  return invokeContractHelp('describeVirtualRouterContractsJson');
}

export function describeMetaCarrierContractsWithNative(): PipelineContractHelp {
  return invokeContractHelp('describeMetaCarrierContractsJson');
}

export function describePipelineContractWithNative(nodeId: string): PipelineContractHelp {
  return invokeContractHelp('describePipelineContractJson', [String(nodeId || '')]);
}

export function validatePipelineNodeContractBoundaryWithNative(
  nodeId: string,
  before: unknown,
  after: unknown
): PipelineContractHelp {
  return invokeContractHelp('validatePipelineNodeContractBoundaryJson', [
    String(nodeId || ''),
    JSON.stringify(before ?? null),
    JSON.stringify(after ?? null)
  ]);
}

export function describeServerContractsWithNative(): PipelineContractHelp {
  return invokeContractHelp('describeServerContractsJson');
}

export function describeServerModuleHelpWithNative(moduleId: string): PipelineContractHelp {
  return invokeContractHelp('describeServerModuleHelpJson', [String(moduleId || '')]);
}
