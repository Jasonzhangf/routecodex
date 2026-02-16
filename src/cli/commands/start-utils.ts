export type RccRunMode = 'router' | 'analysis' | 'server';

type StartCommandArgOptions = {
  logLevel?: string;
  ua?: string;
  quotaRouting?: unknown;
  codex?: boolean;
  claude?: boolean;
  snap?: boolean;
  snapOff?: boolean;
  verboseErrors?: boolean;
  quietErrors?: boolean;
};

export function parseBoolish(value: unknown): boolean | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function normalizeRunMode(value: unknown): RccRunMode | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'router' || normalized === 'analysis' || normalized === 'server') {
    return normalized;
  }
  return null;
}

export function resolveReleaseDaemonEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = String(
    env.ROUTECODEX_START_DAEMON
      ?? env.RCC_START_DAEMON
      ?? '1'
  )
    .trim()
    .toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }
  return true;
}

export function isDaemonSupervisorProcess(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.ROUTECODEX_DAEMON_SUPERVISOR ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function appendFlag(args: string[], enabled: boolean, flag: string): void {
  if (enabled) {
    args.push(flag);
  }
}

export function buildStartCommandArgs(options: StartCommandArgOptions, configPath: string, runMode: RccRunMode): string[] {
  const args: string[] = ['start', '--config', configPath, '--mode', runMode];
  if (typeof options.logLevel === 'string' && options.logLevel.trim()) {
    args.push('--log-level', options.logLevel.trim());
  }
  if (typeof options.ua === 'string' && options.ua.trim()) {
    args.push('--ua', options.ua.trim());
  }
  if (typeof options.quotaRouting === 'string' && options.quotaRouting.trim()) {
    args.push('--quota-routing', options.quotaRouting.trim());
  }
  appendFlag(args, options.codex === true, '--codex');
  appendFlag(args, options.claude === true, '--claude');
  appendFlag(args, options.snap === true, '--snap');
  appendFlag(args, options.snapOff === true, '--snap-off');
  appendFlag(args, options.verboseErrors === true, '--verbose-errors');
  appendFlag(args, options.quietErrors === true, '--quiet-errors');
  return args;
}

export function resolveDaemonRestartDelayMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.ROUTECODEX_DAEMON_RESTART_DELAY_MS ?? env.RCC_DAEMON_RESTART_DELAY_MS ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  // Guardrail: 0ms can cause a hot restart loop when child exits immediately.
  if (!Number.isFinite(parsed) || parsed < 200) {
    return 1200;
  }
  return Math.min(60_000, parsed);
}
