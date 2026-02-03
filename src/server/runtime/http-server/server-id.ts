export function canonicalizeServerId(host: string, port: number): string {
  const rawHost = String(host || '').trim();
  const normalizedHost = (() => {
    if (!rawHost) {
      return '127.0.0.1';
    }
    const lowered = rawHost.toLowerCase();
    // For local dev, treat wildcard binds as localhost to avoid split state namespaces
    // between "0.0.0.0:<port>" and "127.0.0.1:<port>".
    if (lowered === '0.0.0.0' || lowered === '::' || lowered === '::0') {
      return '127.0.0.1';
    }
    return rawHost;
  })();

  const normalizedPort = Number.isFinite(port) ? Math.floor(port) : port;
  return `${normalizedHost}:${normalizedPort}`;
}

