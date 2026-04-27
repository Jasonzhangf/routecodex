import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type RoutePoolTier
} from '../types.js';
import type { NormalizedRoutePoolConfig } from '../bootstrap/routing-config.js';
import { parseVirtualRouterNativeError } from './native-router-hotpath-loader.js';
import { isNativeDisabledByEnv, makeNativeRequiredError } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBinding } from './native-router-hotpath-loader.js';

type NativeRoutingBootstrapPayload = {
  routingSource: Record<string, NormalizedRoutePoolConfig[]>;
  routing: Record<string, RoutePoolTier[]>;
  targetKeys: string[];
};

type ModelIndexEntry = {
  declared: boolean;
  models: string[];
};

function requireNativeFunction(exportName: string): (...args: string[]) => unknown {
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(exportName, 'native disabled');
  }
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw makeNativeRequiredError(exportName);
  }
  return fn as (...args: string[]) => unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseNativePayload(raw: string): NativeRoutingBootstrapPayload | null {
  try {
    const parsed = JSON.parse(raw) as NativeRoutingBootstrapPayload;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (!parsed.routingSource || typeof parsed.routingSource !== 'object') {
      return null;
    }
    if (!parsed.routing || typeof parsed.routing !== 'object') {
      return null;
    }
    if (!isStringArray(parsed.targetKeys)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function bootstrapRoutingWithNative(input: {
  routingSource: Record<string, unknown>;
  aliasIndex: Map<string, string[]>;
  modelIndex: Map<string, ModelIndexEntry>;
}): {
  routingSource: Record<string, NormalizedRoutePoolConfig[]>;
  routing: Record<string, RoutePoolTier[]>;
  targetKeys: Set<string>;
  source: 'native';
} {
  const fn = requireNativeFunction('bootstrapVirtualRouterRoutingJson');
  const aliasIndex = Object.fromEntries(input.aliasIndex.entries());
  const modelIndex = Object.fromEntries(input.modelIndex.entries());

  let raw: unknown;
  try {
    raw = fn(
      JSON.stringify(input.routingSource ?? {}),
      JSON.stringify(aliasIndex),
      JSON.stringify(modelIndex)
    );
  } catch (error) {
    const virtualRouterError = parseVirtualRouterNativeError(error);
    if (virtualRouterError) {
      throw virtualRouterError;
    }
    throw error;
  }

  const returnedVirtualRouterError = parseVirtualRouterNativeError(raw);
  if (returnedVirtualRouterError) {
    throw returnedVirtualRouterError;
  }

  if (typeof raw !== 'string' || !raw) {
    throw new VirtualRouterError(
      'Virtual router native bootstrap returned empty payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }

  const parsed = parseNativePayload(raw);
  if (!parsed) {
    throw new VirtualRouterError(
      'Virtual router native bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }

  return {
    routingSource: parsed.routingSource,
    routing: parsed.routing,
    targetKeys: new Set(parsed.targetKeys),
    source: 'native'
  };
}
