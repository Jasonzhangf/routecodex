export async function enforceWindsurfStartupProbeForHandle(args: {
  providerFamily: string;
  runtimeKey: string;
  instance: { checkHealth(): Promise<boolean> };
}): Promise<void> {
  if (args.providerFamily !== 'windsurf' || process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE === '0') {
    return;
  }
  const healthy = await args.instance.checkHealth();
  if (healthy !== true) {
    throw Object.assign(new Error(`[windsurf] startup probe failed for ${args.runtimeKey}`), {
      code: 'WINDSURF_STARTUP_PROBE_FAILED',
      status: 503,
      retryable: true,
    });
  }
}
