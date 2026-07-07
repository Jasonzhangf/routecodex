const originalFetch = globalThis.fetch?.bind(globalThis);

function isLocalShutdownRequest(input: RequestInfo | URL): boolean {
  try {
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const url = new URL(rawUrl);
    return url.pathname === '/shutdown'
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

if (originalFetch && process.env.ROUTECODEX_JEST_ALLOW_LOCAL_SHUTDOWN !== '1') {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isLocalShutdownRequest(input)) {
      throw new Error('Jest live-safety blocked local RouteCodex /shutdown; inject a fake fetchImpl in the test.');
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}
