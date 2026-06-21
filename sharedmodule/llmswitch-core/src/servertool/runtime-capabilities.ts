type RuntimeCapabilityArgs = unknown;

export type ServertoolRuntimeCapabilities = {
  providerInvoker: boolean;
  reenterPipeline: boolean;
  clientInjectDispatch: boolean;
};

export function deriveServertoolRuntimeCapabilities(
  args: RuntimeCapabilityArgs
): ServertoolRuntimeCapabilities {
  const record: Record<string, unknown> =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return {
    providerInvoker: typeof record.providerInvoker === 'function',
    reenterPipeline: typeof record.reenterPipeline === 'function',
    clientInjectDispatch: typeof record.clientInjectDispatch === 'function'
  };
}
