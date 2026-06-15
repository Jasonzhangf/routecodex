/**
 * Pure helper extracted from http-server/index.ts so unit tests can load the
 * direct decision helpers without importing the full HttpServer class.
 */

export function isClientDisconnectLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    details?: { upstreamMessage?: unknown };
  };
  const code = typeof record.code === 'string' ? record.code.trim().toUpperCase() : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  const upstreamMessage = typeof record.details?.upstreamMessage === 'string'
    ? record.details.upstreamMessage.toLowerCase()
    : '';
  if (code === 'CLIENT_DISCONNECTED') {
    return true;
  }
  if (message.includes('client_disconnected') || message.includes('client disconnected')) {
    return true;
  }
  if (
    record.status === 499
    || record.statusCode === 499
    || code === 'HTTP_499'
    || message.includes('http 499')
  ) {
    if (message.includes('client abort request') || message.includes('client closed request')) {
      return true;
    }
    if (upstreamMessage.includes('client abort request') || upstreamMessage.includes('client closed request')) {
      return true;
    }
  }
  if (message.includes('client abort request') || message.includes('client closed request')) {
    return true;
  }
  if (message.includes('client_request_aborted') || message.includes('client_response_closed')) {
    return true;
  }
  return false;
}
