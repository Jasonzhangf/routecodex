type SessionRecurrenceInput = {
  kind: 'daily' | 'weekly' | 'interval';
  maxRuns: number;
  everyMinutes?: number;
};

const TMUX_SCOPE_PREFIX = 'tmux:';

export function parseString(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed || undefined;
}

export function parseBoolean(input: unknown): boolean | undefined {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return undefined;
}

export function isSessionManagedTerminationEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_SESSION_REAPER_TERMINATE_MANAGED
      ?? process.env.RCC_SESSION_REAPER_TERMINATE_MANAGED
      ?? ''
  ).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return false;
}

export function parsePositiveInt(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function isLocalCallbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

export function validateSessionClientCallbackUrl(input: string): { ok: true; normalizedUrl: string } | { ok: false; reason: string } {
  const value = parseString(input);
  if (!value) {
    return { ok: false, reason: 'callbackUrl is required' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'callbackUrl must be a valid URL' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'callbackUrl protocol must be http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'callbackUrl must not include username/password' };
  }
  if (!isLocalCallbackHost(parsed.hostname)) {
    return { ok: false, reason: 'callbackUrl host must be localhost/loopback' };
  }
  if (!parsed.port) {
    return { ok: false, reason: 'callbackUrl must include an explicit port' };
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'callbackUrl port is invalid' };
  }
  return { ok: true, normalizedUrl: parsed.toString() };
}

function parseIsoToMs(input: unknown): number | null {
  if (typeof input !== 'string') {
    return null;
  }
  const parsed = Date.parse(input.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeClockSessionScope(input: unknown): string | undefined {
  const value = parseString(input);
  if (!value) {
    return undefined;
  }
  if (value.startsWith(TMUX_SCOPE_PREFIX)) {
    return value;
  }
  return `${TMUX_SCOPE_PREFIX}${value}`;
}

function parseRecurrenceKind(raw: unknown): 'daily' | 'weekly' | 'interval' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) {
    return undefined;
  }
  if (value === 'daily' || value === 'day') {
    return 'daily';
  }
  if (value === 'weekly' || value === 'week') {
    return 'weekly';
  }
  if (value === 'interval' || value === 'every_minutes' || value === 'every-minutes' || value === 'everyminutes') {
    return 'interval';
  }
  return undefined;
}

function parseRecurrenceInput(input: unknown, fallbackRecord?: Record<string, unknown>): { recurrence?: SessionRecurrenceInput; error?: string } {
  if (input === undefined || input === null || input === false) {
    return {};
  }

  let kind: 'daily' | 'weekly' | 'interval' | undefined;
  let maxRunsRaw: unknown;
  let everyMinutesRaw: unknown;

  if (typeof input === 'string') {
    kind = parseRecurrenceKind(input);
    maxRunsRaw = fallbackRecord?.maxRuns;
    everyMinutesRaw = fallbackRecord?.everyMinutes;
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    kind = parseRecurrenceKind(rec.kind ?? rec.type ?? rec.mode ?? rec.every);
    maxRunsRaw = rec.maxRuns ?? fallbackRecord?.maxRuns;
    everyMinutesRaw = rec.everyMinutes ?? rec.minutes ?? fallbackRecord?.everyMinutes;
  }

  if (!kind) {
    return { error: 'recurrence kind must be daily|weekly|interval' };
  }

  const maxRunsNum = Number(maxRunsRaw);
  const maxRuns = Number.isFinite(maxRunsNum) ? Math.floor(maxRunsNum) : NaN;
  if (!Number.isFinite(maxRuns) || maxRuns <= 0) {
    return { error: 'recurrence requires maxRuns >= 1' };
  }

  if (kind === 'interval') {
    const everyMinutesNum = Number(everyMinutesRaw);
    const everyMinutes = Number.isFinite(everyMinutesNum) ? Math.floor(everyMinutesNum) : NaN;
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      return { error: 'interval recurrence requires everyMinutes >= 1' };
    }
    return { recurrence: { kind: 'interval', maxRuns, everyMinutes } };
  }

  return { recurrence: { kind, maxRuns } };
}

export function normalizeTaskCreateItems(body: Record<string, unknown>): { items: Record<string, unknown>[]; error?: string } {
  const itemsRaw = Array.isArray(body.items)
    ? body.items
    : [{
      dueAt: body.dueAt,
      task: body.task,
      tool: body.tool,
      arguments: body.arguments,
      recurrence: body.recurrence ?? body.repeat,
      maxRuns: body.maxRuns,
      everyMinutes: body.everyMinutes
    }];

  const items: Record<string, unknown>[] = [];
  for (const entry of itemsRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { items: [], error: 'items must be objects' };
    }
    const record = entry as Record<string, unknown>;
    const dueAtMs = parseIsoToMs(record.dueAt);
    if (!Number.isFinite(dueAtMs as number)) {
      return { items: [], error: 'dueAt must be ISO8601 datetime' };
    }
    const task = parseString(record.task);
    if (!task) {
      return { items: [], error: 'task must be non-empty string' };
    }
    const urls = Array.isArray(record.urls)
      ? record.urls.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
      : undefined;
    const paths = Array.isArray(record.paths)
      ? record.paths.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
      : undefined;
    const recurrenceParsed = parseRecurrenceInput(record.recurrence ?? record.repeat ?? record.cycle, record);
    if (recurrenceParsed.error) {
      return { items: [], error: recurrenceParsed.error };
    }
    const payload: Record<string, unknown> = {
      dueAtMs,
      setBy: 'user',
      prompt: task,
      task,
      ...(parseString(record.tool) ? { tool: parseString(record.tool) } : {}),
      ...(record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
        ? { arguments: record.arguments as Record<string, unknown> }
        : {}),
      ...(urls && urls.length ? { urls } : {}),
      ...(paths && paths.length ? { paths } : {}),
      ...(recurrenceParsed.recurrence ? { recurrence: recurrenceParsed.recurrence } : {})
    };
    items.push(payload);
  }
  return { items };
}

export function normalizeTaskPatch(body: Record<string, unknown>): { patch: Record<string, unknown>; error?: string } {
  const patchRaw = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
    ? (body.patch as Record<string, unknown>)
    : body;

  const patch: Record<string, unknown> = {};

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'dueAt')) {
    const dueAtMs = parseIsoToMs(patchRaw.dueAt);
    if (!Number.isFinite(dueAtMs as number)) {
      return { patch: {}, error: 'patch.dueAt must be ISO8601 datetime' };
    }
    patch.dueAtMs = dueAtMs;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'task')) {
    const task = parseString(patchRaw.task);
    if (!task) {
      return { patch: {}, error: 'patch.task must be non-empty string' };
    }
    patch.prompt = task;
    patch.task = task;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'tool')) {
    patch.tool = patchRaw.tool === null ? null : parseString(patchRaw.tool) ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'arguments')) {
    if (patchRaw.arguments === null) {
      patch.arguments = null;
    } else if (patchRaw.arguments && typeof patchRaw.arguments === 'object' && !Array.isArray(patchRaw.arguments)) {
      patch.arguments = patchRaw.arguments;
    } else {
      return { patch: {}, error: 'patch.arguments must be object or null' };
    }
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'urls')) {
    if (patchRaw.urls === null) {
      patch.urls = null;
    } else if (Array.isArray(patchRaw.urls)) {
      patch.urls = patchRaw.urls
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .map((entry) => String(entry).trim());
    } else {
      return { patch: {}, error: 'patch.urls must be string[] or null' };
    }
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'paths')) {
    if (patchRaw.paths === null) {
      patch.paths = null;
    } else if (Array.isArray(patchRaw.paths)) {
      patch.paths = patchRaw.paths
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .map((entry) => String(entry).trim());
    } else {
      return { patch: {}, error: 'patch.paths must be string[] or null' };
    }
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'recurrence') || Object.prototype.hasOwnProperty.call(patchRaw, 'repeat')) {
    const recurrenceParsed = parseRecurrenceInput(
      patchRaw.recurrence ?? patchRaw.repeat ?? patchRaw.cycle,
      patchRaw
    );
    if (recurrenceParsed.error) {
      return { patch: {}, error: recurrenceParsed.error };
    }
    patch.recurrence = recurrenceParsed.recurrence ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'resetDelivery')) {
    const resetDelivery = parseBoolean(patchRaw.resetDelivery);
    if (resetDelivery === undefined) {
      return { patch: {}, error: 'patch.resetDelivery must be boolean' };
    }
    patch.resetDelivery = resetDelivery;
  }

  return { patch };
}

export function normalizeClockSessionIdInput(input: unknown): string | undefined {
  return normalizeClockSessionScope(input);
}
