export function buildClientSseKeepaliveFrameForHttp(_entryEndpoint?: string): string {
  return ': keepalive\n\n';
}
