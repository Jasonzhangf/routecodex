import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';

import type { GuardianRegistration, GuardianState } from '../guardian/types.js';

type GuardianDaemonOptions = {
  stateFile?: string;
  logFile?: string;
};

type GuardianRegistrationRecord = GuardianRegistration & {
  key: string;
  updatedAt: string;
};

type GuardianLifecycleRecord = {
  id: string;
  action: string;
  source: string;
  actorPid: number;
  targetPid?: number;
  signal?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

const MAX_BODY_BYTES = 256 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function writeLogLine(logFile: string, message: string): void {
  const line = `[guardian][${nowIso()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // ignore daemon logging failures
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of req) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece));
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function validateRegistration(body: Record<string, unknown>): GuardianRegistration {
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const pid = Number(body.pid);
  const ppid = Number(body.ppid);
  if (!source) {
    throw new Error('source is required');
  }
  if (!Number.isFinite(pid) || pid <= 1) {
    throw new Error('pid is invalid');
  }
  if (!Number.isFinite(ppid) || ppid <= 0) {
    throw new Error('ppid is invalid');
  }

  const registration: GuardianRegistration = {
    source,
    pid: Math.floor(pid),
    ppid: Math.floor(ppid)
  };

  const port = Number(body.port);
  if (Number.isFinite(port) && port > 0) {
    registration.port = Math.floor(port);
  }
  if (typeof body.tmuxSessionId === 'string' && body.tmuxSessionId.trim()) {
    registration.tmuxSessionId = body.tmuxSessionId.trim();
  }
  if (typeof body.tmuxTarget === 'string' && body.tmuxTarget.trim()) {
    registration.tmuxTarget = body.tmuxTarget.trim();
  }
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    registration.metadata = body.metadata as Record<string, unknown>;
  }
  return registration;
}

function removeStateFileIfOwned(stateFile: string, pid: number): void {
  try {
    if (!fs.existsSync(stateFile)) {
      return;
    }
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    if (!record) {
      return;
    }
    const filePid = Number(record.pid);
    if (!Number.isFinite(filePid) || Math.floor(filePid) !== Math.floor(pid)) {
      return;
    }
    fs.unlinkSync(stateFile);
  } catch {
    // ignore
  }
}

async function runGuardianDaemon(options: GuardianDaemonOptions): Promise<void> {
  const stateFile = String(options.stateFile || '').trim();
  if (!stateFile) {
    throw new Error('missing --state-file for guardian daemon');
  }
  const logFile = String(options.logFile || '').trim() || `${stateFile}.log`;

  const state: GuardianState = {
    pid: process.pid,
    port: 0,
    token: randomBytes(20).toString('hex'),
    stopToken: randomBytes(20).toString('hex'),
    startedAt: nowIso(),
    updatedAt: nowIso()
  };

  const registrations = new Map<string, GuardianRegistrationRecord>();
  const lifecycleRecords: GuardianLifecycleRecord[] = [];
  let stopping = false;

  const persistState = () => {
    state.updatedAt = nowIso();
    const payload = {
      ...state,
      registrations: Array.from(registrations.values()),
      lifecycleRecords
    };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  };

  const shutdown = (reason: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    writeLogLine(logFile, `shutdown requested: ${reason}`);
    heartbeatTimer.unref();
    server.close(() => {
      removeStateFileIfOwned(stateFile, process.pid);
      process.exit(0);
    });
    setTimeout(() => {
      removeStateFileIfOwned(stateFile, process.pid);
      process.exit(0);
    }, 2000).unref();
  };

  const checkAuth = (req: IncomingMessage): boolean => {
    const token = String(req.headers['x-rcc-guardian-token'] || '').trim();
    return token === state.token;
  };

  const server = createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/health') {
      if (!checkAuth(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, { ok: true, pid: process.pid, registrations: registrations.size });
      return;
    }

    if (method === 'POST' && url === '/register') {
      if (!checkAuth(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      void (async () => {
        try {
          const body = await readJsonBody(req);
          const registration = validateRegistration(body);
          const key = `${registration.source}:${registration.pid}`;
          registrations.set(key, {
            ...registration,
            key,
            updatedAt: nowIso()
          });
          persistState();
          sendJson(res, 200, { ok: true, key, registrations: registrations.size });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })();
      return;
    }

    if (method === 'POST' && url === '/stop') {
      if (!checkAuth(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const stopToken = String(req.headers['x-rcc-guardian-stop-token'] || '').trim();
      if (!stopToken || stopToken !== state.stopToken) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      sendJson(res, 200, { ok: true, stopping: true });
      shutdown('api-stop');
      return;
    }

    if (method === 'POST' && url === '/lifecycle') {
      if (!checkAuth(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      void (async () => {
        try {
          const body = await readJsonBody(req);
          const action = typeof body.action === 'string' ? body.action.trim() : '';
          const source = typeof body.source === 'string' ? body.source.trim() : '';
          const actorPid = Number(body.actorPid);
          if (!action || !source || !Number.isFinite(actorPid) || actorPid <= 0) {
            throw new Error('invalid lifecycle event');
          }
          const item: GuardianLifecycleRecord = {
            id: randomBytes(8).toString('hex'),
            action,
            source,
            actorPid: Math.floor(actorPid),
            createdAt: nowIso()
          };
          const targetPid = Number(body.targetPid);
          if (Number.isFinite(targetPid) && targetPid > 0) {
            item.targetPid = Math.floor(targetPid);
          }
          if (typeof body.signal === 'string' && body.signal.trim()) {
            item.signal = body.signal.trim();
          }
          if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
            item.metadata = body.metadata as Record<string, unknown>;
          }
          lifecycleRecords.push(item);
          if (lifecycleRecords.length > 200) {
            lifecycleRecords.splice(0, lifecycleRecords.length - 200);
          }
          persistState();
          writeLogLine(logFile, `lifecycle action=${item.action} source=${item.source} actorPid=${item.actorPid}`);
          sendJson(res, 200, { ok: true, allowed: true, id: item.id });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })();
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object' && Number.isFinite(addr.port)) {
      state.port = addr.port;
      persistState();
      writeLogLine(logFile, `started pid=${process.pid} port=${state.port}`);
      return;
    }
    writeLogLine(logFile, 'failed to resolve listen address; exiting');
    shutdown('invalid-listen-address');
  });

  server.on('error', (error) => {
    writeLogLine(logFile, `server error: ${error instanceof Error ? error.message : String(error)}`);
    shutdown('server-error');
  });

  const heartbeatTimer = setInterval(() => {
    if (stopping) {
      return;
    }
    try {
      persistState();
    } catch {
      // ignore transient state write failures
    }
  }, 10_000);

  process.on('SIGINT', () => {
    writeLogLine(logFile, 'ignored SIGINT');
  });

  process.on('SIGTERM', () => {
    writeLogLine(logFile, 'ignored SIGTERM');
  });

  await new Promise<void>(() => {
    return;
  });
}

export function createGuardianDaemonCommand(program: Command): void {
  program
    .command('__guardian-daemon', { hidden: true })
    .description('internal guardian daemon (do not use directly)')
    .requiredOption('--state-file <path>', 'guardian state file path')
    .option('--log-file <path>', 'guardian log file path')
    .action(async (options: GuardianDaemonOptions) => {
      await runGuardianDaemon(options);
    });
}
