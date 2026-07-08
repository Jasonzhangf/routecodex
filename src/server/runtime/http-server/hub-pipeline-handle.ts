export type HubPipelineNativeHandle = string;

export type HubPipelineHandle = HubPipelineNativeHandle;

export function readHubPipelineNativeHandle(pipeline: unknown): string | null {
  if (typeof pipeline === 'string' && pipeline.trim()) {
    return pipeline;
  }
  return null;
}
