import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';

function readRouteName(adapterContext: unknown): string | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : undefined;
  const runtime = readRuntimeMetadata(record) as Record<string, unknown> | undefined;
  const candidates = [
    record.routeName,
    metadata?.routeName,
    runtime?.routeName
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function stoplessIsDisabledOnDirectRoute(adapterContext: unknown): boolean {
  const routeName = readRouteName(adapterContext)?.toLowerCase();
  if (!routeName) {
    return false;
  }
  return routeName.startsWith('router-direct') || routeName.startsWith('provider-direct');
}
