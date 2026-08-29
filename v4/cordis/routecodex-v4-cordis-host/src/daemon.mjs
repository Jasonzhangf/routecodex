import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CORDIS_HOST_PROTOCOL_VERSION = 1;
const EPOCH_KINDS = new Set([
  'PrepareEpoch', 'CommitEpoch', 'AbortEpoch', 'DrainEpoch', 'RollbackEpoch',
  'QueryActiveEpoch',
]);
const DEFAULT_CAPABILITIES = Object.freeze([
  'snapshot', 'heartbeat', 'reconcile', 'shutdown', 'epoch-control',
]);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

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

function freezeBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostDaemonError('invalid_epoch_bundle', 'ExecutionEpochBundle must be an object');
  }
  const allowed = new Set([
    'schema_version', 'candidate_id', 'epoch_id', 'manifest_hash', 'graph_hash',
    'plugin_artifact_set_hash', 'entrypoints', 'pipelines', 'nodes', 'policies',
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new CordisHostDaemonError('invalid_epoch_bundle', `unknown bundle field ${unknown}`);
  if (
    value.schema_version !== 1
    || typeof value.candidate_id !== 'string'
    || typeof value.epoch_id !== 'string'
    || !HASH_RE.test(value.manifest_hash)
    || !HASH_RE.test(value.graph_hash)
    || !HASH_RE.test(value.plugin_artifact_set_hash)
    || !value.entrypoints || typeof value.entrypoints !== 'object' || Array.isArray(value.entrypoints)
    || Object.keys(value.entrypoints).length === 0
    || !value.pipelines || typeof value.pipelines !== 'object' || Array.isArray(value.pipelines)
    || !Array.isArray(value.pipelines.request) || value.pipelines.request.length === 0
    || !Array.isArray(value.pipelines.response) || value.pipelines.response.length === 0
    || !Array.isArray(value.pipelines.error) || value.pipelines.error.length === 0
    || !Array.isArray(value.nodes) || value.nodes.length === 0
    || !value.policies || typeof value.policies !== 'object' || Array.isArray(value.policies)
  ) {
    throw new CordisHostDaemonError('invalid_epoch_bundle', 'ExecutionEpochBundle fields are invalid');
  }
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function payloadDigest(payload) {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')}`;
}

function validateControl(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new CordisHostDaemonError('protocol_error', 'epoch control command must be an object');
  }
  const allowed = new Set([
    'schema_version', 'kind', 'command_id', 'generation', 'candidate_id', 'epoch_id',
    'expected_base_hash', 'correlation_id', 'payload_hash', 'payload',
  ]);
  const unknown = Object.keys(command).find((key) => !allowed.has(key));
  if (unknown) throw new CordisHostDaemonError('protocol_error', `unknown control field ${unknown}`);
  if (
    command.schema_version !== 1
    || !EPOCH_KINDS.has(command.kind)
    || typeof command.command_id !== 'string' || command.command_id.length === 0
    || !Number.isSafeInteger(command.generation) || command.generation < 0
    || typeof command.correlation_id !== 'string' || command.correlation_id.length === 0
    || !HASH_RE.test(command.payload_hash)
    || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)
  ) throw new CordisHostDaemonError('protocol_error', 'epoch control command fields are invalid');
  if (command.payload_hash !== payloadDigest(command.payload)) {
    throw new CordisHostDaemonError('payload_hash_mismatch', 'epoch control payload hash does not verify');
  }
  return command;
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
  initialBundle,
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
  const epochState = {
    active: initialBundle === undefined ? null : freezeBundle(initialBundle),
    transactions: new Map(),
  };
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
        if (request.schema_version === 1 || EPOCH_KINDS.has(request.kind)) {
          const command = validateControl(request);
          if (command.generation !== snapshot.generation) {
            throw new CordisHostDaemonError('generation_mismatch', 'epoch control generation mismatch');
          }
          const active = epochState.active;
          const payload = command.payload;
          let result;
          if (command.kind === 'QueryActiveEpoch') {
            result = { active_epoch: active, generation: snapshot.generation };
          } else if (command.kind === 'PrepareEpoch') {
            const candidate = freezeBundle(payload.bundle);
            if (!active) throw new CordisHostDaemonError('active_epoch_unavailable', 'cannot prepare without an active ExecutionEpochBundle');
            if (candidate.epoch_id === active.epoch_id || candidate.candidate_id === active.candidate_id) {
              throw new CordisHostDaemonError('stale_epoch', 'candidate ExecutionEpochBundle is already active');
            }
            if (command.expected_base_hash !== active.manifest_hash) {
              throw new CordisHostDaemonError('stale_base', 'expected base hash does not match active bundle');
            }
            const existing = epochState.transactions.get(command.command_id);
            if (existing) {
              if (JSON.stringify(existing.candidate) !== JSON.stringify(candidate)) {
                throw new CordisHostDaemonError('idempotency_conflict', 'command id was reused with a different bundle');
              }
              result = existing;
            } else {
              result = Object.freeze({ command_id: command.command_id, state: 'Prepared', candidate });
              epochState.transactions.set(command.command_id, result);
            }
          } else {
            const transaction = epochState.transactions.get(command.command_id);
            if (!transaction) throw new CordisHostDaemonError('unknown_transaction', `unknown epoch command ${command.command_id}`);
            const expected = {
              CommitEpoch: 'Prepared', AbortEpoch: 'Prepared', DrainEpoch: 'Committed', RollbackEpoch: 'Committed',
            }[command.kind];
            if (transaction.state !== expected) {
              throw new CordisHostDaemonError('invalid_transaction_state', `${command.kind} requires ${expected}`);
            }
            if (command.kind === 'CommitEpoch') {
              result = Object.freeze({ ...transaction, state: 'Committed', previous: active });
              epochState.active = transaction.candidate;
            } else if (command.kind === 'AbortEpoch') {
              result = Object.freeze({ ...transaction, state: 'Aborted' });
            } else if (command.kind === 'DrainEpoch') {
              result = Object.freeze({ ...transaction, state: 'Draining' });
            } else {
              if (!transaction.previous) throw new CordisHostDaemonError('rollback_unavailable', 'no previous bundle is retained for rollback');
              result = Object.freeze({ ...transaction, state: 'RolledBack' });
              epochState.active = transaction.previous;
            }
            epochState.transactions.set(command.command_id, result);
          }
          void writeState(statePath, { ...snapshot, active_epoch: epochState.active }).then(
            () => reply(socket, { ok: true, kind: command.kind, result }),
            (error) => reply(socket, failure('state_write', error.message)),
          );
          return;
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
  await writeState(statePath, { ...snapshot, active_epoch: epochState.active });

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
  #activeEpoch = null;

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

  async sendEpochControl(command) {
    const response = await request(this.#socketPath, validateControl(command));
    if (response.result && Object.hasOwn(response.result, 'active_epoch')) {
      this.#activeEpoch = response.result.active_epoch;
    }
    return response;
  }

  async prepareEpoch(command) { return this.sendEpochControl({ ...command, kind: 'PrepareEpoch' }); }

  async commitEpoch(command) { return this.sendEpochControl({ ...command, kind: 'CommitEpoch' }); }

  async abortEpoch(command) { return this.sendEpochControl({ ...command, kind: 'AbortEpoch' }); }

  async drainEpoch(command) { return this.sendEpochControl({ ...command, kind: 'DrainEpoch' }); }

  async rollbackEpoch(command) { return this.sendEpochControl({ ...command, kind: 'RollbackEpoch' }); }

  async queryActiveEpoch(command) { return this.sendEpochControl({ ...command, kind: 'QueryActiveEpoch' }); }

  async close() {
    // Client connections are one-shot; close is an explicit no-op for reconnect safety.
  }

  async shutdown() {
    await request(this.#socketPath, { op: 'shutdown' });
  }
}
