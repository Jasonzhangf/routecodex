type ClockRecurrenceInput = {
  kind: 'daily' | 'weekly' | 'interval';
  maxRuns: number;
  everyMinutes?: number;
};

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

export function isClockManagedTerminationEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_CLOCK_REAPER_TERMINATE_MANAGED
      ?? process.env.RCC_CLOCK_REAPER_TERMINATE_MANAGED
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

function parseRecurrenceInput(input: unknown, fallbackRecord?: Record<string, unknown>): { recurrence?: ClockRecurrenceInput; error?: string } {
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
    const recurrenceParsed = parseRecurrenceInput(record.recurrence ?? record.repeat ?? record.cycle, record);
    if (recurrenceParsed.error) {
      return { items: [], error: recurrenceParsed.error };
    }
    const payload: Record<string, unknown> = {
      dueAtMs,
      setBy: 'user',
      task,
      ...(parseString(record.tool) ? { tool: parseString(record.tool) } : {}),
      ...(record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
        ? { arguments: record.arguments as Record<string, unknown> }
        : {}),
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

  if (Object.prototype.hasOwnProperty.call(patchRaw, 'notBeforeRequestId')) {
    patch.notBeforeRequestId = patchRaw.notBeforeRequestId === null
      ? null
      : parseString(patchRaw.notBeforeRequestId) ?? null;
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
