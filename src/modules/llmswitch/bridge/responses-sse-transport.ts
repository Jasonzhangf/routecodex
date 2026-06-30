import { updateResponsesContractProbeFromSseChunkNative } from './native-exports.js';

export function buildClientSseKeepaliveFrameForHttp(_entryEndpoint?: string): string {
  return ': keepalive\n\n';
}

export function shouldDropClientSseFrameForHttp(frame: string, entryEndpoint?: string): boolean {
  return (
    (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
    && frame.trim() === 'data: [DONE]'
  );
}

export function updateResponsesContractProbeFromSseChunkForHttp(
  chunk: unknown,
  probe: Record<string, unknown> | undefined
): Record<string, unknown> {
  return updateResponsesContractProbeFromSseChunkNative(chunk, probe);
}
