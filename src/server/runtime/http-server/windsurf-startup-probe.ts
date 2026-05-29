export async function enforceWindsurfStartupProbeForHandle(args: {
  providerFamily: string;
  runtimeKey: string;
  instance: { checkHealth(): Promise<boolean> };
}): Promise<void> {
  if (args.providerFamily !== 'windsurf' || process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE === '0') {
    return;
  }
  const timeoutRaw = String(
    process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE_TIMEOUT_MS
    || process.env.RCC_WINDSURF_STARTUP_PROBE_TIMEOUT_MS
    || ''
  ).trim();
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 15_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`[windsurf] startup probe timed out for ${args.runtimeKey} after ${timeoutMs}ms`), {
        code: 'WINDSURF_STARTUP_PROBE_TIMEOUT',
        status: 503,
        retryable: true,
      }));
    }, timeoutMs);
    try {
      timer.unref?.();
    } catch {
      // best-effort only
    }
  });
  let healthy: boolean;
  try {
    healthy = await Promise.race([args.instance.checkHealth(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  if (healthy !== true) {
    throw Object.assign(new Error(`[windsurf] startup probe failed for ${args.runtimeKey}`), {
      code: 'WINDSURF_STARTUP_PROBE_FAILED',
      status: 503,
      retryable: true,
    });
  }
}
