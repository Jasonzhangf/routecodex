import { connect as connectTcp, createServer as createTcpServer } from 'node:net';

import { boundedDuration, delay, errorDetails } from './lifecycle-common.mjs';

export function requirePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

export function declaredListenerSet(source, defaultHost, defaultPort) {
  if (Array.isArray(source?.listeners) && source.listeners.length > 0) {
    return source.listeners.map((listener) => ({
      role: listener.role ?? null,
      server_id: listener.server_id ?? null,
      host: listener.host ?? defaultHost,
      port: listener.port,
    }));
  }
  return [
    { role: 'primary', server_id: source?.server_id ?? null, host: defaultHost, port: defaultPort },
  ];
}

export function allocateLoopbackPort(host) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createTcpServer();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPort(error);
    };
    server.once('error', fail);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        if (!Number.isInteger(port) || port < 1) {
          fail(new Error('failed to allocate a loopback admin port'));
          return;
        }
        settled = true;
        resolvePort(port);
      });
    });
  });
}

export async function waitForSocketClosed(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    const attempt = await connectOnce(host, port, Math.min(250, Math.max(1, deadline - Date.now())));
    if (attempt.closed) return { closed: true, error: null };
    lastError = attempt.error;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { closed: false, error: lastError ?? { code: 'ETIMEDOUT', message: 'socket close timeout' } };
}

export async function diagnoseExactBind(host, port, options = {}) {
  const bindHost = host ?? '127.0.0.1';
  const bindPort = requirePort(port, 'port');
  const timeoutMs = boundedDuration(options.timeoutMs ?? 2_000);
  return new Promise((resolveBind) => {
    const server = createTcpServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server.listening) {
        server.close((error) => {
          value.released = !error;
          value.release_error = error ? errorDetails(error) : null;
          resolveBind(value);
        });
        return;
      }
      resolveBind(value);
    };
    const timer = setTimeout(() => {
      finish({
        host: bindHost,
        port: bindPort,
        bound: false,
        released: false,
        error: { name: 'Error', message: `bind timed out after ${timeoutMs}ms`, code: 'ETIMEDOUT' },
      });
    }, timeoutMs);
    server.once('error', (error) => {
      finish({
        host: bindHost,
        port: bindPort,
        bound: false,
        released: true,
        error: errorDetails(error),
      });
    });
    server.listen({ host: bindHost, port: bindPort, exclusive: true }, () => {
      const address = server.address();
      finish({
        host: bindHost,
        port: bindPort,
        bound: true,
        released: false,
        release_error: null,
        address: typeof address === 'object' && address ? { address: address.address, port: address.port } : null,
        error: null,
      });
    });
  });
}

export async function diagnoseListenerSet(listeners, options = {}) {
  const declared = Array.isArray(listeners) ? listeners : [];
  const addresses = [];
  for (const listener of declared) {
    const host = listener?.host ?? '127.0.0.1';
    const port = requirePort(listener?.port, 'port');
    const result = await diagnoseExactBind(host, port, options);
    addresses.push({
      role: listener?.role ?? null,
      server_id: listener?.server_id ?? null,
      host,
      port,
      bound: result.bound,
      released: result.released,
      address: result.address ?? null,
      error: result.error ?? null,
      release_error: result.release_error ?? null,
    });
  }
  const firstFailure = addresses.find((entry) => !entry.bound || !entry.released) ?? null;
  return {
    addresses,
    all_bound: addresses.length > 0 && addresses.every((entry) => entry.bound),
    all_released: addresses.every((entry) => entry.released),
    first_failure: firstFailure,
  };
}

function connectOnce(host, port, timeoutMs) {
  return new Promise((resolveConnect) => {
    const socket = connectTcp({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnect(value);
    };
    socket.setTimeout(timeoutMs, () => {
      finish({ closed: false, error: { code: 'ETIMEDOUT', message: 'connect timeout' } });
    });
    socket.once('connect', () => finish({ closed: false, error: null }));
    socket.once('error', (error) => {
      const details = errorDetails(error);
      if (details.code === 'ECONNREFUSED' || details.code === 'ECONNRESET') {
        finish({ closed: true, error: null });
        return;
      }
      finish({ closed: false, error: details });
    });
  });
}
