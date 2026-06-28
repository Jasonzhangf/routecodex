const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type RuntimeControlWriter = {
  module: string;
  symbol: string;
  stage: string;
};

type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string
  ) => void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readBoundMetadataCenter(target: Record<string, unknown>): MetadataCenterLike | undefined {
  const direct = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (direct && typeof direct.writeRuntimeControl === 'function') {
    return direct;
  }
  const nested = asRecord(target.metadata);
  if (nested) {
    const nestedCenter = Reflect.get(nested, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
    if (nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function') {
      return nestedCenter;
    }
  }
  return undefined;
}

export function applyNativeRuntimeControlWritePlan(args: {
  metadata: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  const center = readBoundMetadataCenter(args.metadata);
  if (!center) {
    throw new Error('MetadataCenter runtime_control write failed: bound MetadataCenter missing');
  }
  for (const [key, value] of Object.entries(args.runtimeControl)) {
    if (value === undefined) {
      continue;
    }
    center.writeRuntimeControl?.(key, value, args.writer, args.reason);
  }
}

export function projectNativeMetadataWritePlanToRuntimeControl(
  plan: Record<string, unknown>
): Record<string, unknown> {
  const runtimeControl: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'learnedNote' || value === undefined || value === null) {
      continue;
    }
    runtimeControl[key] = value;
  }
  return runtimeControl;
}
