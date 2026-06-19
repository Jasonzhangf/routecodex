const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type RuntimeControlWriter = {
  module: string;
  symbol: string;
  stage: string;
};

type StoplessRuntimeControlValue = {
  sessionId?: string;
  flowId: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  continuationPrompt?: string;
  schemaFeedback?: Record<string, unknown>;
  active: boolean;
  updatedAt?: number;
};

type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string
  ) => void;
  readRuntimeControl?: () => Record<string, unknown>;
};

export function writeStoplessRuntimeControlToBoundMetadataCenter(args: {
  metadata: Record<string, unknown>;
  value: StoplessRuntimeControlValue;
  writer: RuntimeControlWriter;
  reason?: string;
  required?: boolean;
}): void {
  const center = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    if (args.required) {
      throw new Error('MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter');
    }
    return;
  }
  center.writeRuntimeControl('stopless', args.value, args.writer, args.reason);
}

export function writeRuntimeControlToBoundMetadataCenter(args: {
  metadata: Record<string, unknown>;
  key: string;
  value: unknown;
  writer: RuntimeControlWriter;
  reason?: string;
  required?: boolean;
}): void {
  const center = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    if (args.required) {
      throw new Error(`MetadataCenter runtime_control.${args.key} writer requires a bound MetadataCenter`);
    }
    return;
  }
  center.writeRuntimeControl(args.key, args.value, args.writer, args.reason);
}

export function readRuntimeControlFromBoundMetadataCenter(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const center = Reflect.get(metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.readRuntimeControl !== 'function') {
    return undefined;
  }
  const runtimeControl = center.readRuntimeControl();
  return runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)
    ? runtimeControl
    : undefined;
}
