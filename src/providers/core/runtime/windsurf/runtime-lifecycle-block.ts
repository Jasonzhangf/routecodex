export type WindsurfManagedRuntimeTerminateResult = {
  pid: number;
  port?: number;
  signalSent: boolean;
  exited: boolean;
  error?: string;
};

export type WindsurfManagedRuntimeAliveCheckResult =
  | {
      ok: true;
      alive: boolean;
    }
  | {
      ok: false;
      alive: false;
      error: {
        code: 'WINDSURF_RUNTIME_PROCESS_INSPECTION_FAILED';
        message: string;
      };
    };

export type WindsurfRuntimeCandidatePlan<RuntimeOptions> = {
  ok: boolean;
  strategy: 'managed' | 'configured' | 'live_routecodex' | 'live_matching_configured' | 'live_scanned';
  candidates: RuntimeOptions[];
  selected: RuntimeOptions | null;
  diagnostics: Array<Record<string, unknown>>;
  error?: { code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE'; message: string };
};

export type WindsurfSelectedRuntimeCandidateResult<RuntimeOptions> =
  | {
      ok: true;
      strategy: WindsurfRuntimeCandidatePlan<RuntimeOptions>['strategy'];
      selected: RuntimeOptions;
      diagnostics: Array<Record<string, unknown>>;
      candidates: RuntimeOptions[];
    }
  | {
      ok: false;
      strategy: WindsurfRuntimeCandidatePlan<RuntimeOptions>['strategy'];
      diagnostics: Array<Record<string, unknown>>;
      candidates: RuntimeOptions[];
      error: { code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE'; message: string };
      reason: 'no_selected_candidate' | 'selected_candidate_missing_ls_port';
    };

export type WindsurfLiveRuntimeLike = {
  lsPort: number;
  csrfToken?: string;
  pid?: number;
  command?: string;
  runChild?: boolean;
  codeiumDir?: string;
};

export type WindsurfLiveRuntimeLineParseResult<RuntimeOptions> =
  | { ok: true; runtime: RuntimeOptions }
  | { ok: false; reason: 'line_shape_mismatch' | 'not_windsurf_language_server' | 'missing_server_port' };

export type WindsurfRoutecodexLiveRuntimeSelectionResult<RuntimeOptions> =
  | {
      ok: true;
      strategy: 'routecodex_live_runtime_selection';
      reason: 'configured_port_exact_match' | 'latest_routecodex_runtime';
      selected: RuntimeOptions;
    }
  | {
      ok: false;
      strategy: 'routecodex_live_runtime_selection';
      reason: 'no_live_runtime_candidates';
    };

export type WindsurfManagedLiveRuntimeSelectionResult<RuntimeOptions> =
  | {
      ok: true;
      strategy: 'managed_live_runtime_selection';
      reason: 'preferred_non_run_child_then_latest_pid';
      selected: RuntimeOptions;
    }
  | {
      ok: false;
      strategy: 'managed_live_runtime_selection';
      reason: 'no_live_runtime_candidates';
    };

export type WindsurfLiveRuntimeDiscoveryResult<RuntimeOptions> =
  | {
      ok: true;
      runtimes: RuntimeOptions[];
      rejected: Array<{
        reason: 'line_shape_mismatch' | 'not_windsurf_language_server' | 'missing_server_port';
        line: string;
      }>;
    }
  | {
      ok: false;
      error: Error;
      reason: 'ps_failed';
    };

export type WindsurfManagedRuntimeResolutionResult<ManagedRuntime> = {
  strategy: 'reuse_pooled_managed_runtime' | 'adopt_live_managed_runtime' | 'spawn_managed_runtime';
  runtime: ManagedRuntime;
};

export type WindsurfManagedRuntimeReuseOrAdoptResult<ManagedRuntime> =
  | {
      ok: true;
      strategy: 'reuse_pooled_managed_runtime' | 'adopt_live_managed_runtime';
      runtime: ManagedRuntime;
      keepPort?: number;
    }
  | {
      ok: false;
      reason: 'no_reusable_pooled_runtime' | 'no_adoptable_live_runtime';
    };

export type WindsurfManagedCodeiumDirArgs = {
  key: string;
  homeDir: string;
  pathJoin: (...parts: string[]) => string;
};

export type WindsurfPinnedGrpcCandidateQueueResult<RuntimeOptions> = {
  queue: RuntimeOptions[];
  diagnostics: Array<Record<string, unknown>>;
};

export type WindsurfManagedRuntimeCandidateAppendResult<RuntimeOptions> =
  | { ok: true; queue: RuntimeOptions[]; diagnostics: Array<Record<string, unknown>>; appended: boolean }
  | { ok: false; queue: RuntimeOptions[]; diagnostics: Array<Record<string, unknown>>; error: unknown };

export type WindsurfManagedRuntimeTerminatorDeps = {
  isTcpPortListening: (port: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  wait?: (ms: number) => void;
  now?: () => number;
};

export type WindsurfManagedLsBinarySelectionResult =
  | { ok: true; strategy: 'managed_ls_binary_executable_selection'; selected: string; attempts: Array<{ path: string; executable: true } | { path: string; executable: false; error: string }> }
  | { ok: false; strategy: 'managed_ls_binary_executable_selection'; attempts: Array<{ path: string; executable: false; error: string }>; error: { code: 'WINDSURF_SERVICE_UNREACHABLE'; message: string } };

export type WindsurfCascadeRewarmPhase = 'start_cascade' | 'send_user_message';
export type WindsurfCascadeRewarmDecision =
  | {
      action: 'rewarm_fresh_cascade';
      phase: WindsurfCascadeRewarmPhase;
      reason: 'panel_state_missing' | 'cascade_expired_or_missing' | 'workspace_untrusted';
      resetReason: string;
    }
  | {
      action: 'propagate_error';
      phase: WindsurfCascadeRewarmPhase;
      reason: 'not_rewarmable';
    };

function defaultWait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isManagedRuntimeProcessAlive(pid: number, sendSignal: (pid: number, signal: NodeJS.Signals | 0) => unknown = process.kill): boolean {
  const result = inspectManagedRuntimeProcessAlive(pid, sendSignal);
  if (!result.ok) {
    throw Object.assign(new Error(result.error.message), result.error);
  }
  return result.alive;
}

export function inspectManagedRuntimeProcessAlive(
  pid: number,
  sendSignal: (pid: number, signal: NodeJS.Signals | 0) => unknown = process.kill,
): WindsurfManagedRuntimeAliveCheckResult {
  if (!Number.isFinite(pid) || pid <= 0) return { ok: true, alive: false };
  try {
    sendSignal(pid, 0);
    return { ok: true, alive: true };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ESRCH') {
      return { ok: true, alive: false };
    }
    return {
      ok: false,
      alive: false,
      error: {
        code: 'WINDSURF_RUNTIME_PROCESS_INSPECTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function confirmManagedRuntimeExited(pid: number, port: number | undefined, deps: WindsurfManagedRuntimeTerminatorDeps): boolean {
  const sendSignal = deps.sendSignal || process.kill;
  const now = deps.now || Date.now;
  const wait = deps.wait || defaultWait;
  const deadline = now() + 1_000;
  while (now() < deadline) {
    const processAlive = isManagedRuntimeProcessAlive(pid, sendSignal);
    const portListening = port ? deps.isTcpPortListening(port) : false;
    if (!processAlive && (!port || !portListening)) {
      return true;
    }
    wait(50);
  }
  const processAlive = isManagedRuntimeProcessAlive(pid, sendSignal);
  const portListening = port ? deps.isTcpPortListening(port) : false;
  return !processAlive && (!port || !portListening);
}

export function terminateManagedRuntimeProcess(pid: number, port: number | undefined, deps: WindsurfManagedRuntimeTerminatorDeps): WindsurfManagedRuntimeTerminateResult {
  const sendSignal = deps.sendSignal || process.kill;
  if (!Number.isFinite(pid) || pid <= 0) {
    return { pid, port, signalSent: false, exited: !port || !deps.isTcpPortListening(port), error: 'missing_pid' };
  }
  let signalSent = false;
  try {
    sendSignal(pid, 'SIGTERM');
    signalSent = true;
  } catch (error) {
    return {
      pid,
      port,
      signalSent: false,
      exited: !isManagedRuntimeProcessAlive(pid, sendSignal) && (!port || !deps.isTcpPortListening(port)),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    pid,
    port,
    signalSent,
    exited: confirmManagedRuntimeExited(pid, port, deps),
  };
}

export function selectWindsurfManagedLsBinaryPath(args: {
  candidates: string[];
  isExecutable: (candidate: string) => void;
}): WindsurfManagedLsBinarySelectionResult {
  const attempts: Array<{ path: string; executable: boolean; error?: string }> = [];
  for (const candidate of args.candidates) {
    try {
      args.isExecutable(candidate);
      const success = { path: candidate, executable: true as const };
      return {
        ok: true,
        strategy: 'managed_ls_binary_executable_selection',
        selected: candidate,
        attempts: [...attempts.filter((attempt): attempt is { path: string; executable: false; error: string } => attempt.executable === false && typeof attempt.error === 'string'), success],
      };
    } catch (error) {
      attempts.push({ path: candidate, executable: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: false,
    strategy: 'managed_ls_binary_executable_selection',
    attempts: attempts.map((attempt) => ({ path: attempt.path, executable: false as const, error: attempt.error || 'not executable' })),
    error: { code: 'WINDSURF_SERVICE_UNREACHABLE', message: '[windsurf] managed LS binary executable not found' },
  };
}

export function commandIsRoutecodexWindsurfRuntime(command: unknown): boolean {
  return /routecodex-windsurf-/i.test(String(command || ''));
}

export function parseWindsurfLiveLocalGrpcRuntimeLine<RuntimeOptions extends WindsurfLiveRuntimeLike>(args: {
  line: string;
  createRuntime: (runtime: WindsurfLiveRuntimeLike) => RuntimeOptions;
}): WindsurfLiveRuntimeLineParseResult<RuntimeOptions> {
  const match = String(args.line || '').trim().match(/^\s*(\d+)\s+(.+)$/);
  if (!match) return { ok: false, reason: 'line_shape_mismatch' };
  const pid = Number.parseInt(match[1] || '', 10);
  const command = match[2] || '';
  if (!(command.includes('/.windsurf/language_server_macos_arm') || command.includes('/extensions/windsurf/bin/language_server_macos_arm'))) {
    return { ok: false, reason: 'not_windsurf_language_server' };
  }
  const portMatch = command.match(/--server_port=(\d+)/);
  const csrfMatch = command.match(/--csrf_token=([^\s]+)/);
  const codeiumDirMatch = command.match(/--codeium_dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const lsPort = portMatch ? Number.parseInt(portMatch[1] || '', 10) : 0;
  if (!Number.isFinite(lsPort) || lsPort <= 0) return { ok: false, reason: 'missing_server_port' };
  return {
    ok: true,
    runtime: args.createRuntime({
      lsPort,
      csrfToken: csrfMatch?.[1],
      pid: Number.isFinite(pid) ? pid : undefined,
      command,
      codeiumDir: codeiumDirMatch?.[1] || codeiumDirMatch?.[2] || codeiumDirMatch?.[3],
      runChild: /(?:^|\s)--run_child(?:\s|$)/.test(command),
    }),
  };
}

export function selectPreferredRoutecodexWindsurfRuntimeResult<RuntimeOptions extends WindsurfLiveRuntimeLike>(args: {
  runtimes: RuntimeOptions[];
  configuredPort?: number;
}): WindsurfRoutecodexLiveRuntimeSelectionResult<RuntimeOptions> {
  if (args.runtimes.length === 0) {
    return {
      ok: false,
      strategy: 'routecodex_live_runtime_selection',
      reason: 'no_live_runtime_candidates',
    };
  }
  if (args.configuredPort && Number.isFinite(args.configuredPort) && args.configuredPort > 0) {
    const exact = args.runtimes.find((row) => row.lsPort === args.configuredPort);
    if (exact) {
      return {
        ok: true,
        strategy: 'routecodex_live_runtime_selection',
        reason: 'configured_port_exact_match',
        selected: exact,
      };
    }
  }
  const routecodexScoped = args.runtimes
    .filter((row) => commandIsRoutecodexWindsurfRuntime(row.command))
    .sort((left, right) => Number(right.pid || 0) - Number(left.pid || 0));
  if (routecodexScoped.length > 0 && routecodexScoped[0]) {
    return {
      ok: true,
      strategy: 'routecodex_live_runtime_selection',
      reason: 'latest_routecodex_runtime',
      selected: routecodexScoped[0],
    };
  }
  return {
    ok: false,
    strategy: 'routecodex_live_runtime_selection',
    reason: 'no_live_runtime_candidates',
  };
}

export function sameWindsurfFilesystemPath(args: { left?: string; right?: string; resolvePath: (value: string) => string }): boolean {
  if (!args.left || !args.right) return false;
  return args.resolvePath(args.left) === args.resolvePath(args.right);
}

export function filterManagedWindsurfRuntimesForCodeiumDir<RuntimeOptions extends WindsurfLiveRuntimeLike>(args: {
  runtimes: RuntimeOptions[];
  expectedDir: string;
  resolvePath: (value: string) => string;
}): RuntimeOptions[] {
  return args.runtimes.filter((runtime) => sameWindsurfFilesystemPath({
    left: runtime.codeiumDir,
    right: args.expectedDir,
    resolvePath: args.resolvePath,
  }));
}

export function selectPreferredManagedWindsurfRuntimeResult<RuntimeOptions extends WindsurfLiveRuntimeLike>(runtimes: RuntimeOptions[]): WindsurfManagedLiveRuntimeSelectionResult<RuntimeOptions> {
  const sorted = [...runtimes].sort((left, right) => {
    if (left.runChild !== right.runChild) return left.runChild ? 1 : -1;
    return Number(right.pid || 0) - Number(left.pid || 0);
  });
  if (sorted[0]) {
    return {
      ok: true,
      strategy: 'managed_live_runtime_selection',
      reason: 'preferred_non_run_child_then_latest_pid',
      selected: sorted[0],
    };
  }
  return {
    ok: false,
    strategy: 'managed_live_runtime_selection',
    reason: 'no_live_runtime_candidates',
  };
}

export function decideWindsurfCascadeRewarmState(phase: WindsurfCascadeRewarmPhase, error: unknown): WindsurfCascadeRewarmDecision {
  const message = String(error instanceof Error ? error.message : error || '');
  if (/panel state not found|not_found.*panel/i.test(message)) {
    return {
      action: 'rewarm_fresh_cascade',
      phase,
      reason: 'panel_state_missing',
      resetReason: phase === 'start_cascade' ? 'cascade_start_panel_state_missing' : 'cascade_send_panel_state_missing',
    };
  }
  if (phase === 'send_user_message' && /not_found.*(cascade|trajectory)|(?:cascade|trajectory).*not[ _-]?found|expired.*cascade|unknown.*cascade/i.test(message)) {
    return {
      action: 'rewarm_fresh_cascade',
      phase,
      reason: 'cascade_expired_or_missing',
      resetReason: 'cascade_send_expired_or_missing',
    };
  }
  if (phase === 'send_user_message' && /untrusted workspace|workspace.*not.*trusted/i.test(message)) {
    return {
      action: 'rewarm_fresh_cascade',
      phase,
      reason: 'workspace_untrusted',
      resetReason: 'cascade_send_workspace_untrusted',
    };
  }
  return { action: 'propagate_error', phase, reason: 'not_rewarmable' };
}

export function buildRoutecodexWindsurfRuntimeCandidatePlan<RuntimeOptions extends { lsPort?: number; csrfToken?: string }>(args: {
  configured: RuntimeOptions;
  liveRuntimes: WindsurfLiveRuntimeLike[];
}): WindsurfRuntimeCandidatePlan<RuntimeOptions> {
  const configured = args.configured || ({} as RuntimeOptions);
  const runtimes = Array.isArray(args.liveRuntimes) ? args.liveRuntimes : [];
  if (runtimes.length === 0) {
    if (!configured.lsPort) {
      return {
        ok: false,
        strategy: 'managed',
        candidates: [],
        selected: null,
        diagnostics: [{ event: 'no_live_language_server', configuredPort: null }],
        error: {
          code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE',
          message: 'no usable windsurf local runtime candidate selected',
        },
      };
    }
    return {
      ok: true,
      strategy: configured.lsPort ? 'configured' : 'managed',
      candidates: [configured],
      selected: configured,
      diagnostics: [{ event: 'no_live_language_server', configuredPort: configured.lsPort || null }],
    };
  }
  const configuredPort = configured.lsPort;
  const selectedRuntimes = runtimes.filter((runtime) => {
    if (configuredPort && runtime.lsPort === configuredPort) return true;
    return commandIsRoutecodexWindsurfRuntime(runtime.command);
  });
  if (selectedRuntimes.length === 0) {
    if (!configured.lsPort) {
      return {
        ok: false,
        strategy: 'managed',
        candidates: [],
        selected: null,
        diagnostics: [{ event: 'no_matching_live_language_server', configuredPort: null, liveCount: runtimes.length }],
        error: {
          code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE',
          message: 'no usable windsurf local runtime candidate selected',
        },
      };
    }
    return {
      ok: true,
      strategy: configured.lsPort ? 'configured' : 'managed',
      candidates: [configured],
      selected: configured,
      diagnostics: [{ event: 'no_matching_live_language_server', configuredPort: configured.lsPort || null, liveCount: runtimes.length }],
    };
  }
  const byPort = new Map<number, WindsurfLiveRuntimeLike[]>();
  for (const runtime of selectedRuntimes) {
    if (!runtime?.lsPort) continue;
    const rows = byPort.get(runtime.lsPort) || [];
    rows.push(runtime);
    byPort.set(runtime.lsPort, rows);
  }
  const candidates: RuntimeOptions[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const [port, rows] of byPort.entries()) {
    const preferred = rows
      .slice()
      .sort((a, b) => {
        const aRunChild = /(?:^|\s)--run_child(?:\s|$)/.test(String(a.command || '')) ? 1 : 0;
        const bRunChild = /(?:^|\s)--run_child(?:\s|$)/.test(String(b.command || '')) ? 1 : 0;
        if (bRunChild !== aRunChild) return bRunChild - aRunChild;
        return Number(b.pid || 0) - Number(a.pid || 0);
      })[0];
    if (!preferred) continue;
    diagnostics.push({ event: 'live_language_server_candidate', port, pid: preferred.pid || null, runChild: preferred.runChild === true });
    candidates.push({
      ...configured,
      lsPort: port,
      csrfToken: preferred.csrfToken || configured.csrfToken,
    });
  }
  candidates.sort((a, b) => Number((b.lsPort || 0)) - Number((a.lsPort || 0)));
  let strategy: WindsurfRuntimeCandidatePlan<RuntimeOptions>['strategy'] = 'live_scanned';
  if (configured.lsPort && candidates.some((row) => row.lsPort === configured.lsPort)) {
    strategy = 'live_matching_configured';
  } else if (candidates.some((row) => commandIsRoutecodexWindsurfRuntime(selectedRuntimes.find((runtime) => runtime.lsPort === row.lsPort)?.command))) {
    strategy = 'live_routecodex';
  }
  if (configured.lsPort && !candidates.some((row) => row.lsPort === configured.lsPort)) {
    diagnostics.push({ event: 'configured_runtime_rejected_after_live_scan', configuredPort: configured.lsPort });
  }
  const selected = candidates[0] || null;
  return {
    ok: !!selected,
    strategy,
    candidates,
    selected,
    diagnostics,
    ...(selected ? {} : {
      error: {
        code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE' as const,
        message: 'no usable windsurf local runtime candidate selected',
      },
    }),
  };
}


export function buildPinnedGrpcRuntimeCandidateQueue<RuntimeOptions extends { lsPort?: number; csrfToken?: string }>(args: {
  routecodexCandidates: RuntimeOptions[];
  configuredRuntime?: RuntimeOptions | null;
}): WindsurfPinnedGrpcCandidateQueueResult<RuntimeOptions> {
  const queue: RuntimeOptions[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: RuntimeOptions | null | undefined, source: string): void => {
    if (!candidate) {
      diagnostics.push({ event: 'runtime_candidate_rejected', source, reason: 'missing_candidate' });
      return;
    }
    if (!candidate.lsPort || !Number.isFinite(candidate.lsPort) || candidate.lsPort <= 0) {
      diagnostics.push({ event: 'runtime_candidate_rejected', source, reason: 'missing_ls_port' });
      return;
    }
    const key = `${candidate.lsPort}:${candidate.csrfToken || ''}`;
    if (seen.has(key)) {
      diagnostics.push({ event: 'runtime_candidate_rejected', source, reason: 'duplicate_candidate', lsPort: candidate.lsPort });
      return;
    }
    seen.add(key);
    queue.push(candidate);
    diagnostics.push({ event: 'runtime_candidate_queued', source, lsPort: candidate.lsPort, hasCsrfToken: typeof candidate.csrfToken === 'string' && candidate.csrfToken.length > 0 });
  };

  for (const candidate of args.routecodexCandidates || []) {
    pushCandidate(candidate, 'routecodex_live_or_configured');
  }
  if (queue.length === 0) {
    pushCandidate(args.configuredRuntime, 'configured_runtime');
  }
  return { queue, diagnostics };
}

export function appendManagedRuntimeCandidate<RuntimeOptions extends { lsPort?: number; csrfToken?: string }>(args: {
  queue: RuntimeOptions[];
  diagnostics: Array<Record<string, unknown>>;
  candidate: RuntimeOptions;
}): WindsurfManagedRuntimeCandidateAppendResult<RuntimeOptions> {
  const key = `${args.candidate?.lsPort || ''}:${args.candidate?.csrfToken || ''}`;
  if (!args.candidate || !args.candidate.lsPort || !Number.isFinite(args.candidate.lsPort) || args.candidate.lsPort <= 0) {
    return {
      ok: false,
      queue: args.queue,
      diagnostics: [...args.diagnostics, { event: 'runtime_candidate_rejected', source: 'managed_runtime', reason: 'missing_ls_port' }],
      error: new Error('[windsurf] managed runtime candidate missing lsPort'),
    };
  }
  const exists = args.queue.some((row) => `${row.lsPort || ''}:${row.csrfToken || ''}` == key);
  if (exists) {
    return {
      ok: true,
      queue: args.queue,
      diagnostics: [...args.diagnostics, { event: 'runtime_candidate_rejected', source: 'managed_runtime', reason: 'duplicate_candidate', lsPort: args.candidate.lsPort }],
      appended: false,
    };
  }
  return {
    ok: true,
    queue: [...args.queue, args.candidate],
    diagnostics: [...args.diagnostics, { event: 'runtime_candidate_queued', source: 'managed_runtime', lsPort: args.candidate.lsPort, hasCsrfToken: typeof args.candidate.csrfToken === 'string' && args.candidate.csrfToken.length > 0 }],
    appended: true,
  };
}

export function resolveSelectedWindsurfRuntimeCandidate<RuntimeOptions extends { lsPort?: number; csrfToken?: string }>(
  plan: WindsurfRuntimeCandidatePlan<RuntimeOptions>
): WindsurfSelectedRuntimeCandidateResult<RuntimeOptions> {
  if (!plan.selected) {
    return {
      ok: false,
      strategy: plan.strategy,
      diagnostics: plan.diagnostics,
      candidates: plan.candidates,
      error: plan.error || {
        code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE',
        message: 'no usable windsurf local runtime candidate selected',
      },
      reason: 'no_selected_candidate',
    };
  }
  if (!plan.selected.lsPort) {
    return {
      ok: false,
      strategy: plan.strategy,
      diagnostics: plan.diagnostics,
      candidates: plan.candidates,
      error: plan.error || {
        code: 'WINDSURF_RUNTIME_CANDIDATE_UNAVAILABLE',
        message: 'no usable windsurf local runtime candidate selected',
      },
      reason: 'selected_candidate_missing_ls_port',
    };
  }
  return {
    ok: true,
    strategy: plan.strategy,
    selected: plan.selected,
    diagnostics: plan.diagnostics,
    candidates: plan.candidates,
  };
}

export function discoverWindsurfLiveLocalGrpcRuntimes<RuntimeOptions extends WindsurfLiveRuntimeLike>(args: {
  psStdout: string;
  parseLine: (line: string) => WindsurfLiveRuntimeLineParseResult<RuntimeOptions>;
  onRejectedLine?: (entry: {
    reason: 'line_shape_mismatch' | 'not_windsurf_language_server' | 'missing_server_port';
    line: string;
  }) => void;
}): WindsurfLiveRuntimeDiscoveryResult<RuntimeOptions> {
  const runtimes: RuntimeOptions[] = [];
  const rejected: Array<{
    reason: 'line_shape_mismatch' | 'not_windsurf_language_server' | 'missing_server_port';
    line: string;
  }> = [];
  for (const row of String(args.psStdout || '').split(/\r?\n/)) {
    const parsed = args.parseLine(row);
    if (!parsed.ok) {
      if (row.trim()) {
        const entry = { reason: parsed.reason, line: row.trim() };
        rejected.push(entry);
        args.onRejectedLine?.(entry);
      }
      continue;
    }
    runtimes.push(parsed.runtime);
  }
  return { ok: true, runtimes, rejected };
}

export function resolveManagedWindsurfCodeiumDir(args: WindsurfManagedCodeiumDirArgs): string {
  const safeKey = String(args.key || 'windsurf-default-runtime').replace(/[^a-zA-Z0-9._-]/g, '_');
  return args.pathJoin(args.homeDir, '.rcc', 'windsurf-ls', safeKey);
}

export function filterManagedWindsurfRuntimesForKey<RuntimeOptions extends WindsurfLiveRuntimeLike>(args: {
  key: string;
  runtimes: RuntimeOptions[];
  homeDir: string;
  pathJoin: (...parts: string[]) => string;
  resolvePath: (value: string) => string;
}): RuntimeOptions[] {
  const expectedDir = resolveManagedWindsurfCodeiumDir({
    key: args.key,
    homeDir: args.homeDir,
    pathJoin: args.pathJoin,
  });
  return filterManagedWindsurfRuntimesForCodeiumDir({
    runtimes: args.runtimes,
    expectedDir,
    resolvePath: args.resolvePath,
  });
}

export function selectPreferredManagedWindsurfRuntimeForKeyResult<RuntimeOptions extends WindsurfLiveRuntimeLike>(args: {
  key: string;
  runtimes: RuntimeOptions[];
  homeDir: string;
  pathJoin: (...parts: string[]) => string;
  resolvePath: (value: string) => string;
}): WindsurfManagedLiveRuntimeSelectionResult<RuntimeOptions> {
  const filtered = filterManagedWindsurfRuntimesForKey(args);
  return selectPreferredManagedWindsurfRuntimeResult(filtered);
}

export function resolveReusableOrAdoptableManagedRuntime<ManagedRuntime extends {
  port: number;
  csrfToken: string;
  ready: boolean;
  process: { exitCode: number | null; signalCode: NodeJS.Signals | number | null };
  sessionId: string | null;
  workspaceInit: Promise<void> | null;
}, LiveRuntime extends WindsurfLiveRuntimeLike>(args: {
  pooledRuntime: ManagedRuntime | undefined;
  liveSelection: WindsurfManagedLiveRuntimeSelectionResult<LiveRuntime>;
  configuredCsrfToken?: string;
  defaultCsrfToken: string;
  isTcpPortListening: (port: number) => boolean;
  buildAdoptedRuntime: (payload: {
    port: number;
    csrfToken: string;
  }) => ManagedRuntime;
}): WindsurfManagedRuntimeReuseOrAdoptResult<ManagedRuntime> {
  const existing = args.pooledRuntime;
  if (
    existing
    && existing.ready
    && existing.process.exitCode == null
    && existing.process.signalCode == null
    && args.isTcpPortListening(existing.port)
  ) {
    return {
      ok: true,
      strategy: 'reuse_pooled_managed_runtime',
      runtime: existing,
    };
  }
  const live = args.liveSelection;
  if (live.ok && live.selected.lsPort && args.isTcpPortListening(live.selected.lsPort)) {
    return {
      ok: true,
      strategy: 'adopt_live_managed_runtime',
      keepPort: live.selected.lsPort,
      runtime: args.buildAdoptedRuntime({
        port: live.selected.lsPort,
        csrfToken: live.selected.csrfToken || args.configuredCsrfToken || args.defaultCsrfToken,
      }),
    };
  }
  return {
    ok: false,
    reason: existing ? 'no_adoptable_live_runtime' : 'no_reusable_pooled_runtime',
  };
}
