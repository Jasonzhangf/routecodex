type ClockScopeTraceMode = 'off' | 'auto' | 'on' | 'verbose';

function readTraceModeRaw(): string {
  return String(process.env.ROUTECODEX_CLOCK_SCOPE_TRACE ?? process.env.RCC_CLOCK_SCOPE_TRACE ?? '')
    .trim()
    .toLowerCase();
}

export function resolveClockScopeTraceMode(): ClockScopeTraceMode {
  const raw = readTraceModeRaw();
  if (!raw || raw === 'auto' || raw === 'default') {
    return 'auto';
  }
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
    return 'off';
  }
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') {
    return 'on';
  }
  if (raw === '2' || raw === 'verbose' || raw === 'debug' || raw === 'trace') {
    return 'verbose';
  }
  return 'auto';
}

export function isClockScopeTraceEnabled(): boolean {
  const mode = resolveClockScopeTraceMode();
  return mode === 'on' || mode === 'verbose';
}

export function isClockScopeTraceVerbose(): boolean {
  return resolveClockScopeTraceMode() === 'verbose';
}

export function shouldTraceClockScopeByContext(args: {
  endpointOrPath: string;
  userAgent?: string;
  originator?: string;
  hasTurnMetadata?: boolean;
}): boolean {
  const mode = resolveClockScopeTraceMode();
  if (mode === 'off') {
    return false;
  }
  if (mode === 'on' || mode === 'verbose') {
    return true;
  }

  const endpoint = args.endpointOrPath || '';
  if (!(endpoint.startsWith('/v1/') || endpoint.startsWith('/openai/') || endpoint.startsWith('/responses'))) {
    return false;
  }
  const userAgent = (args.userAgent || '').toLowerCase();
  const originator = (args.originator || '').toLowerCase();
  return (
    userAgent.includes('codex')
    || userAgent.includes('claude')
    || originator.includes('codex')
    || originator.includes('claude')
    || args.hasTurnMetadata === true
  );
}
