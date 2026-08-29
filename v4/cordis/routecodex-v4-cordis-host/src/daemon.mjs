import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CORDIS_HOST_PROTOCOL_VERSION = 1;
const DEFAULT_CAPABILITIES = Object.freeze(['snapshot', 'heartbeat', 'reconcile', 'shutdown']);

export class CordisHostDaemonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CordisHostDaemonError';
    this.code = code;
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CordisHostDaemonError('protocol_error', `${name} is required`);
  }
  return value;
}

function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostDaemonError('protocol_error', 'daemon snapshot must be an object');
  }
  if (
    value.protocolVersion !== CORDIS_HOST_PROTOCOL_VERSION
    || typeof value.version !== 'string'
    || typeof value.generation !== 'number'
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || typeof value.graphHash !== 'string'
    || !Array.isArray(value.capabilities)
    || value.capabilities.some((item) => typeof item !== 'string')
    || typeof value.lastHeartbeatAt !== 'number'
  ) {
    throw new CordisHostDaemonError('protocol_error', 'daemon snapshot fields are invalid');
  }
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]) });
}

async function writeState(statePath, snapshot) {
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { flag: 'wx' });
  await fs.rename(temporary, statePath);
}

async function readState(statePath) {
  const contents = await fs.readFile(statePath, 'utf8').then(
    (value) => value,
    (error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (contents === null) return undefined;
  try {
    return validateSnapshot(JSON.parse(contents));
  } catch (error) {
    if (error instanceof CordisHostDaemonError) throw error;
    throw new CordisHostDaemonError('state_invalid', `daemon state is invalid: ${error.message}`);
  }
}

function reply(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

function failure(code, message) {
  return { ok: false, code, message };
}

export async function startCordisHostDaemon({
  stateDirectory,
  socketPath,
  graphHash,
  version,
  capabilities = DEFAULT_CAPABILITIES,
}) {
  requireString(stateDirectory, 'stateDirectory');
  requireString(socketPath, 'socketPath');
  requireString(graphHash, 'graphHash');
  requireString(version, 'version');
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new CordisHostDaemonError('protocol_error', 'capabilities must be non-empty strings');
  }
  await fs.mkdir(stateDirectory, { recursive: true });
  const socketExists = await fs.stat(socketPath).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (socketExists) {
    throw new CordisHostDaemonError('already_running', `daemon socket already exists: ${socketPath}`);
  }

  const statePath = path.join(stateDirectory, 'daemon.json');
  const previous = await readState(statePath);
  const snapshot = {
    protocolVersion: CORDIS_HOST_PROTOCOL_VERSION,
    version,
    generation: previous ? previous.generation + 1 : 1,
    graphHash,
    capabilities: [...capabilities],
    lastHeartbeatAt: Date.now(),
  };
  validateSnapshot(snapshot);

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.includes('\n') && !handled) {
        handled = true;
        socket.emit('request-line');
      }
    });
    socket.once('error', () => {});
    socket.once('request-line', () => {
      let request;
      try {
        request = JSON.parse(input.trim());
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          throw new CordisHostDaemonError('protocol_error', 'daemon request must be an object');
        }
        const allowed = {
          handshake: ['op', 'protocolVersion', 'graphHash'],
          snapshot: ['op'],
          heartbeat: ['op', 'generation'],
          reconcile: ['op', 'generation', 'graphHash'],
          shutdown: ['op'],
        }[request.op];
        if (!allowed) throw new CordisHostDaemonError('protocol_error', `unknown daemon operation ${request.op}`);
        const unknown = Object.keys(request).find((key) => !allowed.includes(key));
        if (unknown) throw new CordisHostDaemonError('protocol_error', `unknown daemon request field ${unknown}`);
        if (request.op === 'handshake') {
          if (request.protocolVersion !== CORDIS_HOST_PROTOCOL_VERSION) {
            throw new CordisHostDaemonError('protocol_version_mismatch', 'daemon protocol version mismatch');
          }
          if (request.graphHash !== undefined && request.graphHash !== snapshot.graphHash) {
            throw new CordisHostDaemonError('graph_hash_mismatch', 'daemon graph hash mismatch');
          }
          reply(socket, { ok: true, snapshot });
        } else if (request.op === 'snapshot') {
          reply(socket, { ok: true, snapshot });
        } else if (request.op === 'heartbeat') {
          if (request.generation !== snapshot.generation) {
            throw new CordisHostDaemonError('generation_mismatch', 'daemon generation mismatch');
          }
          snapshot.lastHeartbeatAt = Date.now();
          writeState(statePath, snapshot).then(
            () => reply(socket, { ok: true, snapshot }),
            (error) => reply(socket, failure('state_write', error.message)),
          );
        } else if (request.op === 'reconcile') {
          if (request.generation !== snapshot.generation) {
            throw new CordisHostDaemonError('generation_mismatch', 'daemon generation mismatch');
          }
          if (request.graphHash !== snapshot.graphHash) {
            throw new CordisHostDaemonError('graph_hash_mismatch', 'daemon graph hash mismatch');
          }
          reply(socket, { ok: true, reconciled: true, snapshot });
        } else {
          reply(socket, { ok: true, snapshot });
          void daemon.shutdown();
        }
      } catch (error) {
        const daemonError = error instanceof CordisHostDaemonError
          ? error
          : new CordisHostDaemonError('protocol_error', error.message);
        reply(socket, failure(daemonError.code, daemonError.message));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  }).catch((error) => {
    throw new CordisHostDaemonError('socket_bind', error.message);
  });
  await writeState(statePath, snapshot);

  const daemon = {
    snapshot: () => validateSnapshot(snapshot),
    shutdown: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      await fs.unlink(socketPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
  return daemon;
}

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.once('error', (error) => reject(new CordisHostDaemonError('socket_error', error.message)));
    socket.on('data', (chunk) => { input += chunk; });
    socket.once('connect', () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.once('end', () => {
      try {
        const value = JSON.parse(input);
        if (!value.ok) throw new CordisHostDaemonError(value.code, value.message);
        resolve(value);
      } catch (error) {
        reject(error instanceof CordisHostDaemonError
          ? error
          : new CordisHostDaemonError('protocol_error', error.message));
      }
    });
  });
}

export class CordisHostDaemonClient {
  #socketPath;
  #snapshot;

  constructor(socketPath, snapshot) {
    this.#socketPath = socketPath;
    this.#snapshot = validateSnapshot(snapshot);
  }

  static async connect({ socketPath, graphHash }) {
    requireString(socketPath, 'socketPath');
    const response = await request(socketPath, {
      op: 'handshake',
      protocolVersion: CORDIS_HOST_PROTOCOL_VERSION,
      ...(graphHash === undefined ? {} : { graphHash }),
    });
    return new CordisHostDaemonClient(socketPath, response.snapshot);
  }

  snapshot() { return this.#snapshot; }

  async querySnapshot() {
    const response = await request(this.#socketPath, { op: 'snapshot' });
    this.#snapshot = validateSnapshot(response.snapshot);
    return this.#snapshot;
  }

  async heartbeat() {
    const response = await request(this.#socketPath, { op: 'heartbeat', generation: this.#snapshot.generation });
    this.#snapshot = validateSnapshot(response.snapshot);
    return this.#snapshot;
  }

  async reconcile({ generation, graphHash }) {
    const response = await request(this.#socketPath, { op: 'reconcile', generation, graphHash });
    this.#snapshot = validateSnapshot(response.snapshot);
    return { reconciled: response.reconciled, snapshot: this.#snapshot };
  }

  async close() {
    // Client connections are one-shot; close is an explicit no-op for reconnect safety.
  }

  async shutdown() {
    await request(this.#socketPath, { op: 'shutdown' });
  }
}
