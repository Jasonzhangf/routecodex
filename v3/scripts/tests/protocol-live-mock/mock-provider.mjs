// Loopback mock provider for the protocol live-mock matrix.
//
// This module owns one node:http listener and the scripted provider responses
// for a single case/turn. It is import-safe: the listener starts only when the
// caller invokes startMockProvider(). It never calls RCC, Magpie, the network,
// or a production provider, and it retains raw request evidence for callers.
import { createServer } from 'node:http';

const PROTOCOLS = Object.freeze(['openai_chat', 'responses', 'anthropic', 'gemini']);
const PROTOCOL_SET = new Set(PROTOCOLS);
const SCRIPT_MODES = new Set(['json', 'sse', 'fault']);
const FAULT_TRUNCATE = new Set(['truncate', 'stream_cut', 'stream_cut_before_content']);

export const MOCK_PROVIDER_PATHS = Object.freeze({
  openai_chat: Object.freeze(['/v1/chat/completions']),
  responses: Object.freeze(['/v1/responses', '/v1/responses/compact']),
  anthropic: Object.freeze(['/v1/messages']),
  gemini: Object.freeze([':generateContent', ':streamGenerateContent']),
});

export class MockProviderError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'MockProviderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// startMockProvider(options) -> Promise<handle>
//
// options.port      fixed port, or 0 for an ephemeral port (default 0)
// options.host      bind host (default 127.0.0.1)
// options.isProbe   optional ({method,path,query,headers,body,rawBody,phase,caseId,turn}) => boolean
//                   narrow explicit probe classifier; replaces the default
//                   catalog/health GET classification when provided
// options.validateRequest optional (capture, fixture, turn) => void; a rejection
//                   is returned before the scripted business response is sent
export async function startMockProvider(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const state = {
    phase: 'startup',
    fixture: null,
    turn: 0,
    turnTransition: null,
    attemptByTurn: new Map(),
    captures: [],
    heldByCase: new Map(),
    heldWaiters: new Map(),
  };
  const sockets = new Set();
  const server = createServer((request, response) => {
    handleRequest(request, response, options, state).catch((error) => {
      sendFacilityError(response, error);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await listen(server, options.port ?? 0, host);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : Number(options.port ?? 0);

  return {
    port,
    url: `http://${host}:${port}`,
    get phase() {
      return state.phase;
    },
    setActiveCase(fixture, turnIndex = 0) {
      if (!isPlainObject(fixture) || typeof fixture.case_id !== 'string' || fixture.case_id.length === 0) {
        throw new MockProviderError('mock_invalid_fixture', 'setActiveCase requires a fixture with a string case_id');
      }
      if (!PROTOCOL_SET.has(fixture.cell?.provider_protocol)) {
        throw new MockProviderError('mock_invalid_fixture', `fixture provider_protocol must be one of ${PROTOCOLS.join(', ')}`);
      }
      state.fixture = fixture;
      state.turn = nonNegativeInteger(turnIndex, 'turnIndex');
      state.turnTransition = null;
      state.attemptByTurn.clear();
      state.phase = 'case';
      return { case_id: fixture.case_id, turn: state.turn, phase: 'case' };
    },
    setTurn(turnIndex) {
      state.turn = nonNegativeInteger(turnIndex, 'turnIndex');
      return { turn: state.turn, phase: state.phase };
    },
    advanceTurnAfterResponse(caseId, fromTurn, toTurn) {
      if (typeof caseId !== 'string' || caseId.length === 0) {
        throw new MockProviderError('mock_invalid_transition', 'advanceTurnAfterResponse requires a case id');
      }
      state.turnTransition = {
        caseId,
        fromTurn: nonNegativeInteger(fromTurn, 'fromTurn'),
        toTurn: nonNegativeInteger(toTurn, 'toTurn'),
      };
      return { ...state.turnTransition };
    },
    getCaptures(caseId) {
      const all = state.captures.map(cloneValue);
      if (caseId === undefined) return all;
      return all.filter((capture) => capture.case_id === caseId);
    },
    waitForHeld(caseId, timeoutMs = 2000) {
      requireCaseId(caseId, 'waitForHeld');
      if (state.heldByCase.has(caseId)) return Promise.resolve(heldReceipt(caseId));
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: () => {
            clearTimeout(timer);
            resolve(heldReceipt(caseId));
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          const waiters = state.heldWaiters.get(caseId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) state.heldWaiters.delete(caseId);
          reject(new MockProviderError(
            'mock_hold_timeout',
            `controlled hold did not arrive for ${caseId} within ${timeoutMs}ms`,
            504,
          ));
        }, positiveInteger(timeoutMs, 'timeoutMs'));
        const waiters = state.heldWaiters.get(caseId) ?? new Set();
        waiters.add(waiter);
        state.heldWaiters.set(caseId, waiters);
      });
    },
    releaseHeld(caseId) {
      requireCaseId(caseId, 'releaseHeld');
      const held = state.heldByCase.get(caseId) ?? null;
      if (!held) return 0;
      state.heldByCase.delete(caseId);
      applyTurnTransition(held.capture, state);
      for (const fragment of held.remaining) writeWire(held.response, held.wire, fragment);
      endWire(held.response, held.wire);
      return 1;
    },
    async close() {
      for (const held of state.heldByCase.values()) {
        try {
          held.response.end();
        } catch {
          // The tracked socket teardown below remains the primary close owner.
        }
      }
      state.heldByCase.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await closeServer(server);
    },
  };
}

async function handleRequest(request, response, options, state) {
  const rawBody = await readBody(request);
  const bodyText = rawBody.toString('utf8');
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const headers = lowerHeaders(request.headers);
  let body = null;
  let bodyParsed = false;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
      bodyParsed = true;
    } catch {
      bodyParsed = false;
    }
  }

  const businessPath = isKnownBusinessPath(url.pathname);
  const probe = businessPath ? false : classifyProbe(request.method, url, headers, body, state, options);
  const capture = {
    phase: state.phase,
    case_id: state.phase === 'case' && state.fixture ? state.fixture.case_id : null,
    turn: state.turn,
    attempt: null,
    attempt_kind: businessPath ? 'business' : probe ? 'probe' : 'unknown',
    protocol: classifyProtocol(url.pathname),
    method: request.method,
    path: url.pathname,
    query: url.search,
    headers,
    content_type: headers['content-type'] ?? null,
    raw_body: bodyText,
    body,
    body_parsed: bodyParsed,
    captured_at_epoch_ms: Date.now(),
    response_script: null,
  };

  if (probe) {
    capture.response_script = { mode: 'probe', status: 200 };
    state.captures.push(capture);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }

  if (!businessPath) {
    state.captures.push(capture);
    throw new MockProviderError('mock_provider_unknown_contract', `unsupported mock provider request: ${request.method} ${url.pathname}`, 404);
  }

  if (request.method !== 'POST') {
    state.captures.push(capture);
    throw new MockProviderError('mock_provider_contract_mismatch', `business attempt must use POST: ${request.method} ${url.pathname}`);
  }

  if (state.phase !== 'case' || !state.fixture) {
    state.captures.push(capture);
    throw new MockProviderError('mock_provider_no_active_case', `business request before setActiveCase: ${request.method} ${url.pathname}`);
  }

  const providerProtocol = state.fixture.cell.provider_protocol;
  if (!isPathForProtocol(url.pathname, providerProtocol)) {
    state.captures.push(capture);
    throw new MockProviderError(
      'mock_provider_contract_mismatch',
      `path ${url.pathname} does not match active fixture provider ${providerProtocol}`,
    );
  }

  const attemptIndex = state.attemptByTurn.get(state.turn) ?? 0;
  state.attemptByTurn.set(state.turn, attemptIndex + 1);
  const scripts = scriptsForTurn(state.fixture, state.turn);
  const { script, repeated } = scriptAt(scripts, attemptIndex);
  capture.attempt = attemptIndex;
  capture.attempt_repeated = repeated;
  capture.response_script = cloneValue(script);
  const responseWire = createResponseWireCapture(script);
  capture.response_wire = responseWire.receipt;
  state.captures.push(capture);

  if (typeof options.validateRequest === 'function') {
    try {
      await options.validateRequest(capture, state.fixture, state.turn);
    } catch (error) {
      capture.response_script = {
        mode: 'request_rejected',
        status: error instanceof MockProviderError ? error.statusCode : 500,
      };
      throw error;
    }
  }

  const sendReceipt = await sendScript(script, response, responseWire);
  if (sendReceipt.held) {
    state.heldByCase.set(capture.case_id, {
      response,
      remaining: sendReceipt.remaining,
      capture,
      wire: responseWire,
    });
    const waiters = state.heldWaiters.get(capture.case_id);
    if (waiters) {
      state.heldWaiters.delete(capture.case_id);
      for (const waiter of waiters) waiter.resolve();
    }
    return;
  }
  applyTurnTransition(capture, state);
}

function scriptsForTurn(fixture, turn) {
  const turnFixture = Array.isArray(fixture.turns) ? fixture.turns[turn] : null;
  const upstream = turnFixture?.upstream_response ?? fixture.upstream_response;
  return scriptsOf(upstream);
}

function scriptsOf(upstream) {
  if (!isPlainObject(upstream)) throw new MockProviderError('mock_invalid_upstream_response', 'upstream_response must be an object');
  if (!PROTOCOL_SET.has(upstream.protocol)) {
    throw new MockProviderError('mock_invalid_upstream_protocol', `unsupported upstream protocol: ${upstream.protocol ?? 'missing'}`);
  }
  if (Array.isArray(upstream.attempts)) {
    if (upstream.attempts.length === 0) throw new MockProviderError('mock_invalid_upstream_response', 'attempts must be a non-empty array');
    return upstream.attempts.map((attempt, index) => normalizeScript(attempt, upstream, `attempts[${index}]`));
  }
  return [normalizeScript(upstream, null, 'upstream_response')];
}

function normalizeScript(source, inherited, label) {
  if (!isPlainObject(source)) throw new MockProviderError('mock_invalid_attempt', `${label} must be an object`);
  const mode = source.mode ?? source.kind ?? (Array.isArray(source.body) || isPlainObject(source.body) ? 'json' : Array.isArray(source.sse_events) || Array.isArray(source.chunks) ? 'sse' : null);
  if (!SCRIPT_MODES.has(mode)) throw new MockProviderError('mock_invalid_attempt_mode', `${label} has unsupported mode: ${mode ?? 'missing'}`);
  const script = {
    ...source,
    mode,
    status: source.status ?? inherited?.status ?? 200,
    content_type: source.content_type ?? inherited?.content_type ?? (mode === 'sse' ? 'text/event-stream' : 'application/json'),
  };
  if (mode === 'json' && !isPlainObject(script.body) && !Array.isArray(script.body)) {
    throw new MockProviderError('mock_invalid_attempt', `${label} needs an object body for json mode`);
  }
  if (mode === 'sse' && !Array.isArray(script.chunks) && !Array.isArray(script.sse_events)) {
    throw new MockProviderError('mock_invalid_attempt', `${label} needs chunks or sse_events for sse mode`);
  }
  if (mode === 'fault') {
    script.fault = source.fault ?? inherited?.fault;
    if (typeof script.fault !== 'string' || script.fault.length === 0) {
      throw new MockProviderError('mock_invalid_attempt', `${label} needs a non-empty fault string`);
    }
    if (script.close_after_bytes === undefined && inherited?.close_after_bytes !== undefined) {
      script.close_after_bytes = inherited.close_after_bytes;
    }
    if (script.close_after_bytes !== undefined) script.close_after_bytes = nonNegativeInteger(script.close_after_bytes, `${label}.close_after_bytes`);
  }
  if (!Number.isInteger(script.status) || script.status < 100 || script.status > 599) {
    throw new MockProviderError('mock_invalid_attempt', `${label}.status must be an HTTP status code`);
  }
  return script;
}

function scriptAt(scripts, index) {
  if (index < scripts.length) return { script: scripts[index], repeated: false };
  return { script: scripts[scripts.length - 1], repeated: true };
}

async function sendScript(script, response, wire) {
  if (script.mode === 'json') {
    response.writeHead(script.status, { 'content-type': script.content_type });
    writeWire(response, wire, JSON.stringify(script.body));
    endWire(response, wire);
    return { held: false };
  }
  if (script.mode === 'sse') {
    if (script.fault === 'reset') {
      wire.receipt.reset = true;
      response.socket?.destroy();
      return { held: false };
    }
    response.writeHead(script.status, { 'content-type': script.content_type });
    const fragments = sseFragments(script);
    if (script.fault && FAULT_TRUNCATE.has(script.fault)) {
      writeTruncated(response, wire, fragments, script.close_after_bytes);
      return { held: false };
    }
    if (script.fault === 'hold-open') {
      writeWire(response, wire, fragments[0] ?? '');
      return { held: false };
    }
    if (script.fault === 'hold-open-controlled') {
      writeWire(response, wire, fragments[0] ?? '');
      return { held: true, remaining: fragments.slice(1) };
    }
    for (const fragment of fragments) writeWire(response, wire, fragment);
    endWire(response, wire);
    return { held: false };
  }
  // fault mode
  if (script.fault === 'reset') {
    wire.receipt.reset = true;
    response.socket?.destroy();
    return { held: false };
  }
  if (FAULT_TRUNCATE.has(script.fault)) {
    response.writeHead(script.status, { 'content-type': script.content_type ?? 'text/event-stream' });
    const fragments = Array.isArray(script.chunks) || Array.isArray(script.sse_events) ? sseFragments(script) : [`data: ${JSON.stringify({ fault: script.fault })}\n\n`];
    writeTruncated(response, wire, fragments, script.close_after_bytes);
    return { held: false };
  }
  if (script.fault === 'hold-open') {
    response.writeHead(script.status, { 'content-type': script.content_type ?? 'text/event-stream' });
    writeWire(response, wire, 'data: {"status":"holding"}\n\n');
    return { held: false };
  }
  if (script.fault === 'hold-open-controlled') {
    response.writeHead(script.status, { 'content-type': script.content_type ?? 'text/event-stream' });
    const fragments = Array.isArray(script.chunks) || Array.isArray(script.sse_events)
      ? sseFragments(script)
      : ['data: {"status":"holding"}\n\n'];
    writeWire(response, wire, fragments[0] ?? '');
    return { held: true, remaining: fragments.slice(1) };
  }
  response.writeHead(script.status, { 'content-type': script.content_type ?? 'application/json' });
  writeWire(response, wire, JSON.stringify(script.body ?? { error: { message: script.fault } }));
  endWire(response, wire);
  return { held: false };
}

function applyTurnTransition(capture, state) {
  const transition = state.turnTransition;
  if (transition
    && transition.caseId === capture.case_id
    && transition.fromTurn === capture.turn
    && capture.attempt_kind === 'business') {
    state.turn = transition.toTurn;
    state.turnTransition = null;
  }
}

function heldReceipt(caseId) {
  return { case_id: caseId, held: true };
}

function requireCaseId(caseId, operation) {
  if (typeof caseId !== 'string' || caseId.length === 0) {
    throw new MockProviderError('mock_invalid_case_id', `${operation} requires a case id`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MockProviderError('mock_invalid_duration', `${label} must be a positive integer`);
  }
  return value;
}

function createResponseWireCapture(script) {
  return {
    chunks: [],
    receipt: {
      mode: script.mode,
      status: script.status,
      content_type: script.content_type ?? null,
      text: '',
      text_byte_length: 0,
      bytes_base64: '',
      complete: false,
      truncated: false,
      reset: false,
    },
  };
}

function writeWire(response, wire, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  wire.chunks.push(bytes);
  response.write(bytes);
}

function endWire(response, wire) {
  const bytes = Buffer.concat(wire.chunks);
  wire.receipt.text = bytes.toString('utf8');
  wire.receipt.text_byte_length = bytes.length;
  wire.receipt.bytes_base64 = bytes.toString('base64');
  wire.receipt.complete = true;
  wire.receipt.truncated = false;
  response.end();
}

function writeTruncated(response, wire, fragments, closeAfterBytes) {
  let bytes = 0;
  for (const fragment of fragments) {
    if (typeof fragment !== 'string') throw new MockProviderError('mock_invalid_sse_chunk', 'SSE fragments must be raw strings');
    const chunk = Buffer.from(fragment, 'utf8');
    if (closeAfterBytes !== undefined && bytes + chunk.byteLength > closeAfterBytes) {
      const remaining = closeAfterBytes - bytes;
      if (remaining > 0) writeWire(response, wire, chunk.subarray(0, remaining));
      wire.receipt.truncated = true;
      endWire(response, wire);
      wire.receipt.complete = false;
      return;
    }
    writeWire(response, wire, chunk);
    bytes += chunk.byteLength;
    if (closeAfterBytes !== undefined && bytes >= closeAfterBytes) {
      wire.receipt.truncated = true;
      endWire(response, wire);
      wire.receipt.complete = false;
      return;
    }
  }
  endWire(response, wire);
}

function sseFragments(script) {
  if (Array.isArray(script.chunks)) {
    for (const chunk of script.chunks) {
      if (typeof chunk !== 'string') throw new MockProviderError('mock_invalid_sse_chunk', 'chunks must be raw strings');
    }
    return script.chunks;
  }
  return script.sse_events.map(renderSseEvent);
}

function renderSseEvent(event) {
  if (typeof event === 'string') return event.endsWith('\n\n') ? event : `${event}\n\n`;
  if (!isPlainObject(event)) throw new MockProviderError('mock_invalid_sse_event', 'sse_events entries must be strings or objects');
  if (typeof event.raw === 'string') return event.raw;
  const lines = [];
  if (typeof event.event === 'string' && event.event.length > 0) lines.push(`event: ${event.event}`);
  lines.push(`data: ${renderSseData(event.data)}`);
  return `${lines.join('\n')}\n\n`;
}

function renderSseData(data) {
  if (typeof data === 'string') return data;
  if (data === undefined) return '';
  return JSON.stringify(data);
}

function classifyProbe(method, url, headers, body, state, options) {
  if (typeof options.isProbe === 'function') {
    const verdict = options.isProbe({
      method,
      path: url.pathname,
      query: url.search,
      headers,
      body,
      phase: state.phase,
      caseId: state.fixture?.case_id ?? null,
      turn: state.turn,
    });
    return verdict === true;
  }
  if (method !== 'GET') return false;
  return url.pathname === '/health'
    || url.pathname === '/healthz'
    || url.pathname === '/v1/models'
    || url.pathname === '/v1beta/models'
    || url.pathname === '/v1/responses/models';
}

function isKnownBusinessPath(path) {
  return PROTOCOLS.some((protocol) => isPathForProtocol(path, protocol));
}

function isPathForProtocol(path, protocol) {
  if (!PROTOCOL_SET.has(protocol)) return false;
  if (protocol === 'gemini') {
    return path.startsWith('/v1beta/models/')
      && (path.includes(':generateContent') || path.includes(':streamGenerateContent'));
  }
  return MOCK_PROVIDER_PATHS[protocol].includes(path);
}

function classifyProtocol(path) {
  for (const protocol of PROTOCOLS) {
    if (isPathForProtocol(path, protocol)) return protocol;
  }
  return 'unknown';
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function lowerHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers ?? {})) result[key.toLowerCase()] = value;
  return result;
}

function nonNegativeInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MockProviderError('mock_invalid_integer', `${label} must be a non-negative integer`);
  }
  return parsed;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sendFacilityError(response, error) {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  const statusCode = error instanceof MockProviderError ? error.statusCode : 500;
  const code = error instanceof MockProviderError ? error.code : 'mock_provider_internal_error';
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: code, message: error.message }));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
