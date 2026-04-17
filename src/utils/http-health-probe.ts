import { API_PATHS, HTTP_PROTOCOLS } from '../constants/index.js';

type ProbeFailureKind =
  | 'timeout'
  | 'network_error'
  | 'auth_error'
  | 'bad_status'
  | 'bad_json'
  | 'not_routecodex'
  | 'not_guardian';

type ProbeSuccess<T> = {
  ok: true;
  kind: 'ok';
  status: number;
  body: T;
  bodySnippet?: string;
};

type ProbeFailure = {
  ok: false;
  kind: ProbeFailureKind;
  status?: number;
  bodySnippet?: string;
  parseOk?: boolean;
  errorMessage?: string;
};

type ProbeResult<T> = ProbeSuccess<T> | ProbeFailure;

export type RouteCodexHealthBody = {
  server?: string;
  status?: string;
  ready?: boolean;
  pipelineReady?: boolean;
};

export type RouteCodexHealthProbeResult = ProbeResult<RouteCodexHealthBody>;

export type GuardianHealthBody = {
  ok?: boolean;
};

export type GuardianHealthProbeResult = ProbeResult<GuardianHealthBody>;

type RawHttpResponse =
  | {
      ok?: boolean;
      status?: number;
      text?: () => Promise<string>;
      json?: () => Promise<unknown>;
    }
  | Response;

type TimedFetchResult =
  | { ok: true; response: RawHttpResponse; status: number }
  | { ok: false; kind: 'timeout' | 'network_error'; errorMessage: string };

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown');
}

function compactSnippet(text: string, max = 180): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function safeJsonSnippet(value: unknown): string {
  try {
    return compactSnippet(JSON.stringify(value));
  } catch {
    return compactSnippet(String(value ?? ''));
  }
}

async function fetchWithTimeout(args: {
  fetchImpl: typeof fetch;
  url: string;
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
}): Promise<TimedFetchResult> {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, args.timeoutMs);
  try {
    const response = await args.fetchImpl(args.url, {
      method: args.method ?? 'GET',
      headers: args.headers,
      signal: controller.signal
    });
    return {
      ok: true,
      response: response as RawHttpResponse,
      status: Number((response as { status?: number })?.status ?? 0)
    };
  } catch (error) {
    return {
      ok: false,
      kind: didTimeout ? 'timeout' : 'network_error',
      errorMessage: formatUnknownError(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonBody(response: RawHttpResponse): Promise<
  | { ok: true; body: unknown; bodySnippet?: string }
  | { ok: false; bodySnippet?: string; errorMessage: string }
> {
  if (typeof response.text === 'function') {
    try {
      const text = await response.text();
      if (!String(text || '').trim()) {
        return { ok: false, bodySnippet: '', errorMessage: 'empty response body' };
      }
      try {
        return {
          ok: true,
          body: JSON.parse(text) as unknown,
          bodySnippet: compactSnippet(text)
        };
      } catch (error) {
        return {
          ok: false,
          bodySnippet: compactSnippet(text),
          errorMessage: formatUnknownError(error)
        };
      }
    } catch (error) {
      return { ok: false, errorMessage: formatUnknownError(error) };
    }
  }

  if (typeof response.json === 'function') {
    try {
      const body = await response.json();
      return {
        ok: true,
        body,
        bodySnippet: safeJsonSnippet(body)
      };
    } catch (error) {
      return { ok: false, errorMessage: formatUnknownError(error) };
    }
  }

  return { ok: false, errorMessage: 'response body reader unavailable' };
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function isRouteCodexHealthy(body: RouteCodexHealthBody): boolean {
  const status = typeof body?.status === 'string' ? body.status.toLowerCase() : '';
  return body?.server === 'routecodex'
    && (
      status === 'healthy'
      || status === 'ready'
      || status === 'ok'
      || body?.ready === true
      || body?.pipelineReady === true
    );
}

export function describeHealthProbeFailure(result: ProbeFailure): string {
  const parts: string[] = [result.kind];
  if (typeof result.status === 'number' && result.status > 0) {
    parts.push(`status=${result.status}`);
  }
  if (result.errorMessage) {
    parts.push(`error=${result.errorMessage}`);
  }
  if (result.bodySnippet) {
    parts.push(`body=${result.bodySnippet}`);
  }
  return parts.join(' ');
}

export async function probeRouteCodexHealth(args: {
  fetchImpl: typeof fetch;
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<RouteCodexHealthProbeResult> {
  const request = await fetchWithTimeout({
    fetchImpl: args.fetchImpl,
    url: `${HTTP_PROTOCOLS.HTTP}${args.host}:${args.port}${API_PATHS.HEALTH}`,
    timeoutMs: Math.max(1, args.timeoutMs ?? 800)
  });
  if (!request.ok) {
    return request;
  }

  if (isAuthStatus(request.status)) {
    return { ok: false, kind: 'auth_error', status: request.status };
  }

  const body = await readJsonBody(request.response);
  if (!body.ok) {
    return {
      ok: false,
      kind: 'bad_json',
      status: request.status,
      parseOk: false,
      bodySnippet: body.bodySnippet,
      errorMessage: body.errorMessage
    };
  }

  const healthBody = (body.body ?? {}) as RouteCodexHealthBody;
  if (request.status < 200 || request.status >= 300) {
    return {
      ok: false,
      kind: 'bad_status',
      status: request.status,
      parseOk: true,
      bodySnippet: body.bodySnippet
    };
  }

  if (healthBody?.server !== 'routecodex') {
    return {
      ok: false,
      kind: 'not_routecodex',
      status: request.status,
      parseOk: true,
      bodySnippet: body.bodySnippet
    };
  }

  if (!isRouteCodexHealthy(healthBody)) {
    return {
      ok: false,
      kind: 'bad_status',
      status: request.status,
      parseOk: true,
      bodySnippet: body.bodySnippet
    };
  }

  return {
    ok: true,
    kind: 'ok',
    status: request.status,
    body: healthBody,
    bodySnippet: body.bodySnippet
  };
}

export async function probeGuardianHealth(args: {
  fetchImpl: typeof fetch;
  port: number;
  token: string;
  timeoutMs?: number;
}): Promise<GuardianHealthProbeResult> {
  const request = await fetchWithTimeout({
    fetchImpl: args.fetchImpl,
    url: `${HTTP_PROTOCOLS.HTTP}127.0.0.1:${args.port}/health`,
    timeoutMs: Math.max(1, args.timeoutMs ?? 1200),
    headers: {
      'x-rcc-guardian-token': args.token
    }
  });
  if (!request.ok) {
    return request;
  }

  if (isAuthStatus(request.status)) {
    return { ok: false, kind: 'auth_error', status: request.status };
  }

  const body = await readJsonBody(request.response);
  if (!body.ok) {
    return {
      ok: false,
      kind: 'bad_json',
      status: request.status,
      parseOk: false,
      bodySnippet: body.bodySnippet,
      errorMessage: body.errorMessage
    };
  }

  const healthBody = (body.body ?? {}) as GuardianHealthBody;
  if (request.status < 200 || request.status >= 300) {
    return {
      ok: false,
      kind: 'bad_status',
      status: request.status,
      parseOk: true,
      bodySnippet: body.bodySnippet
    };
  }

  if (healthBody?.ok !== true) {
    return {
      ok: false,
      kind: 'not_guardian',
      status: request.status,
      parseOk: true,
      bodySnippet: body.bodySnippet
    };
  }

  return {
    ok: true,
    kind: 'ok',
    status: request.status,
    body: healthBody,
    bodySnippet: body.bodySnippet
  };
}
