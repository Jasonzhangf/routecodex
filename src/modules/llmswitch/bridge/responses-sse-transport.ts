export function buildClientSseKeepaliveFrameForHttp(_entryEndpoint?: string): string {
  return ': keepalive\n\n';
}

export function shouldDropClientSseFrameForHttp(frame: string, entryEndpoint?: string): boolean {
  return (
    (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
    && frame.trim() === 'data: [DONE]'
  );
}
