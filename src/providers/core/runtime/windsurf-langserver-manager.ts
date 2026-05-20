import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import * as http2 from 'http2';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { closeSessionForPort, grpcFrame, grpcUnary, LS_SERVICE } from './grpc/grpc-client.js';
import {
  buildAddTrackedWorkspaceRequest,
  buildGetUserStatusRequest,
  buildHeartbeatRequest,
  buildInitializePanelStateRequest,
  buildUpdatePanelStateWithUserStatusRequest,
  buildUpdateWorkspaceTrustRequest,
  extractUserStatusBytes,
} from './grpc/windsurf-grpc-bridge.js';

const WINDSURF_TRANSPORT_ERROR_RE = /pending stream has been canceled|ECONNRESET|ERR_HTTP2|session closed|stream closed|panel state/i;
const DEFAULT_CSRF = 'windsurf-api-csrf-fixed-token';
const DEFAULT_PORT = 42100;
const DEFAULT_API_SERVER_URL = 'https://server.self-serve.windsurf.com';
const DEFAULT_REGISTER_USER_URL = 'https://api.codeium.com/register_user/';
const seededWorkspaces = new Set<string>();
const entries = new Map<string, WindsurfLangserverEntry>();
const pending = new Map<string, Promise<WindsurfLangserverEntry>>();
let nextPort = DEFAULT_PORT + 1;

export interface WindsurfLangserverEntry {
  key: string;
  port: number;
  csrfToken: string;
  workspacePath: string;
  sessionId: string | null;
  workspaceInitPromise: Promise<void> | null;
  ready: boolean;
  generation: number;
  lastReadyAt: number | null;
  process: ChildProcessWithoutNullStreams | null;
  startedAt: number;
}

export interface EnsureWindsurfLangserverReadyOptions {
  apiKey: string;
  port?: number;
  csrfToken?: string;
  workspacePath: string;
  binaryPath?: string;
  apiServerUrl?: string;
  codeiumDir?: string;
  databaseDir?: string;
}

function defaultBinaryPath(): string {
  return process.env.LS_BINARY_PATH
    || process.env.WINDSURF_LS_BINARY_PATH
    || path.join(os.homedir(), '.windsurf', 'language_server_macos_arm');
}

function buildEntryKey(workspacePath: string): string {
  return workspacePath;
}

function isWindsurfCascadeTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return WINDSURF_TRANSPORT_ERROR_RE.test(message);
}

function isLegacyWorkspaceScaffold(workspacePath: string): boolean {
  try {
    const pkgPath = path.join(workspacePath, 'package.json');
    if (!existsSync(pkgPath)) {
      return false;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.name !== 'proxy-workspace-stub';
  } catch {
    return false;
  }
}

function writeWorkspaceStubFiles(workspacePath: string): void {
  writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
    name: 'proxy-workspace-stub',
    version: '0.0.0',
    private: true,
    description: 'Empty placeholder created by RouteCodex Windsurf provider. NOT the user project.',
    license: 'UNLICENSED',
  }, null, 2) + '\n');
  writeFileSync(path.join(workspacePath, 'README.md'), '# Proxy workspace placeholder\n\nThis directory exists only so the Windsurf language server has a workspace to register. It is NOT the user project.\n');
  writeFileSync(path.join(workspacePath, '.gitignore'), '# proxy workspace placeholder\n');
}

function ensureWorkspaceDir(workspacePath: string): void {
  if (seededWorkspaces.has(workspacePath)) {
    return;
  }
  try {
    const exists = existsSync(workspacePath);
    if (exists && isLegacyWorkspaceScaffold(workspacePath)) {
      try {
        rmSync(path.join(workspacePath, 'src'), { recursive: true, force: true });
      } catch {}
      writeWorkspaceStubFiles(workspacePath);
      seededWorkspaces.add(workspacePath);
      return;
    }
    if (!exists) {
      mkdirSync(workspacePath, { recursive: true });
      writeWorkspaceStubFiles(workspacePath);
    }
    seededWorkspaces.add(workspacePath);
  } catch {
    // placeholder scaffold only
  }
}

function buildLanguageServerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.HOME ||= process.env.HOME || os.homedir();
  return env;
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitPortReady(port: number, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        const timer = setTimeout(() => {
          try { client.close(); } catch {}
          reject(new Error('timeout'));
        }, 2000);
        client.on('connect', () => {
          clearTimeout(timer);
          try { client.close(); } catch {}
          resolve();
        });
        client.on('error', (error) => {
          clearTimeout(timer);
          try { client.close(); } catch {}
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`LS port ${port} not ready after ${timeoutMs}ms`);
}

function resolvePort(preferred?: number): Promise<number> {
  return (async () => {
    let port = preferred && preferred > 0 ? Math.floor(preferred) : nextPort++;
    if (port === DEFAULT_PORT && await isPortInUse(port)) {
      do {
        port = nextPort++;
      } while (await isPortInUse(port));
      return port;
    }
    while (await isPortInUse(port)) {
      port = nextPort++;
    }
    return port;
  })();
}

async function tryUpdatePanelStateWithUserStatus(
  apiKey: string,
  entry: WindsurfLangserverEntry,
): Promise<void> {
  try {
    const statusResp = await grpcUnary(
      entry.port,
      entry.csrfToken,
      `${LS_SERVICE}/GetUserStatus`,
      grpcFrame(buildGetUserStatusRequest(apiKey)),
      5000,
    );
    const userStatusBytes = extractUserStatusBytes(statusResp);
    if (!userStatusBytes) {
      return;
    }
    await grpcUnary(
      entry.port,
      entry.csrfToken,
      `${LS_SERVICE}/UpdatePanelStateWithUserStatus`,
      grpcFrame(buildUpdatePanelStateWithUserStatusRequest(apiKey, entry.sessionId || randomUUID(), userStatusBytes)),
      5000,
    );
  } catch {
    // non-blocking by reference mainline
  }
}

function throwWarmupTransportError(stage: string, entry: WindsurfLangserverEntry, error: unknown): never {
  resetWindsurfLangserverSession(entry);
  const source = error instanceof Error ? error : new Error(String(error));
  throw new Error(`${stage}: ${source.message}`);
}

function spawnLangserver(options: EnsureWindsurfLangserverReadyOptions, port: number, csrfToken: string): ChildProcessWithoutNullStreams {
  const binaryPath = options.binaryPath || defaultBinaryPath();
  if (!existsSync(binaryPath)) {
    throw new Error(`Language server binary not found at ${binaryPath}`);
  }
  const codeiumDir = options.codeiumDir || path.join(options.workspacePath, '.windsurf');
  const databaseDir = options.databaseDir || path.join(codeiumDir, 'db');
  mkdirSync(databaseDir, { recursive: true });
  const args = [
    `--api_server_url=${options.apiServerUrl || DEFAULT_API_SERVER_URL}`,
    `--server_port=${port}`,
    `--csrf_token=${csrfToken}`,
    `--register_user_url=${DEFAULT_REGISTER_USER_URL}`,
    `--codeium_dir=${codeiumDir}`,
    `--database_dir=${databaseDir}`,
    '--detect_proxy=false',
  ];
  return spawn(binaryPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildLanguageServerEnv(),
  });
}

export function resolveWindsurfWorkspacePath(apiKey: string): string {
  const suffix = apiKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16) || 'default';
  return path.join(os.tmpdir(), `routecodex-windsurf-${suffix}`);
}

export function getOrCreateWindsurfLangserverEntry(
  options: Omit<EnsureWindsurfLangserverReadyOptions, 'apiKey'> & { port: number; csrfToken: string; process?: ChildProcessWithoutNullStreams | null },
): WindsurfLangserverEntry {
  const key = buildEntryKey(options.workspacePath);
  const existing = entries.get(key);
  if (existing) {
    return existing;
  }
  const created: WindsurfLangserverEntry = {
    key,
    port: options.port,
    csrfToken: options.csrfToken,
    workspacePath: options.workspacePath,
    sessionId: null,
    workspaceInitPromise: null,
    ready: false,
    generation: 0,
    lastReadyAt: null,
    process: options.process || null,
    startedAt: Date.now(),
  };
  entries.set(key, created);
  return created;
}

export async function ensureWindsurfLangserverReady(
  options: EnsureWindsurfLangserverReadyOptions,
): Promise<WindsurfLangserverEntry> {
  const key = buildEntryKey(options.workspacePath);
  const existing = entries.get(key);
  if (existing?.ready) {
    return existing;
  }
  const inflight = pending.get(key);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    const port = await resolvePort(options.port);
    const csrfToken = options.csrfToken?.trim() || DEFAULT_CSRF;
    ensureWorkspaceDir(options.workspacePath);
    const proc = spawnLangserver(options, port, csrfToken);
    const entry = getOrCreateWindsurfLangserverEntry({
      ...options,
      port,
      csrfToken,
      process: proc,
    });

    proc.on('exit', () => {
      entry.ready = false;
      entry.workspaceInitPromise = null;
      entry.sessionId = null;
      closeSessionForPort(entry.port);
    });

    await waitPortReady(port, 25000);
    entry.ready = true;
    entry.lastReadyAt = Date.now();
    if (!entry.sessionId) {
      entry.sessionId = randomUUID();
    }
    if (entry.workspaceInitPromise) {
      await entry.workspaceInitPromise;
      return entry;
    }
    entry.workspaceInitPromise = (async () => {
      try {
        await grpcUnary(entry.port, entry.csrfToken, `${LS_SERVICE}/InitializeCascadePanelState`, grpcFrame(
          buildInitializePanelStateRequest(options.apiKey, entry.sessionId || randomUUID())
        ), 5000);
      } catch (error) {
        if (isWindsurfCascadeTransportError(error)) {
          throwWarmupTransportError('InitializeCascadePanelState', entry, error);
        }
        throw error;
      }
      try {
        await grpcUnary(entry.port, entry.csrfToken, `${LS_SERVICE}/AddTrackedWorkspace`, grpcFrame(
          buildAddTrackedWorkspaceRequest(entry.workspacePath)
        ), 5000);
      } catch (error) {
        if (isWindsurfCascadeTransportError(error)) {
          throwWarmupTransportError('AddTrackedWorkspace', entry, error);
        }
        throw error;
      }
      try {
        await grpcUnary(entry.port, entry.csrfToken, `${LS_SERVICE}/UpdateWorkspaceTrust`, grpcFrame(
          buildUpdateWorkspaceTrustRequest(
            options.apiKey,
            `file://${entry.workspacePath}`,
            true,
            entry.sessionId || randomUUID(),
          )
        ), 5000);
      } catch (error) {
        if (isWindsurfCascadeTransportError(error)) {
          throwWarmupTransportError('UpdateWorkspaceTrust', entry, error);
        }
        throw error;
      }
      try {
        await grpcUnary(entry.port, entry.csrfToken, `${LS_SERVICE}/Heartbeat`, grpcFrame(
          buildHeartbeatRequest(options.apiKey, entry.sessionId || randomUUID())
        ), 5000);
      } catch (error) {
        if (isWindsurfCascadeTransportError(error)) {
          throwWarmupTransportError('Heartbeat', entry, error);
        }
        throw error;
      }
      await tryUpdatePanelStateWithUserStatus(options.apiKey, entry);
      entry.ready = true;
      entry.lastReadyAt = Date.now();
    })().catch((error) => {
      entry.workspaceInitPromise = null;
      entry.ready = false;
      throw error;
    });
    await entry.workspaceInitPromise;
    return entry;
  })();

  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}

export function resetWindsurfLangserverSession(entry: WindsurfLangserverEntry): void {
  closeSessionForPort(entry.port);
  entry.workspaceInitPromise = null;
  entry.sessionId = null;
  entry.ready = false;
  entry.generation += 1;
  entry.lastReadyAt = null;
}

export const __windsurfLangserverManagerTestables = {
  clear(): void {
    for (const entry of entries.values()) {
      try {
        entry.process?.kill('SIGTERM');
      } catch {}
    }
    entries.clear();
    pending.clear();
    seededWorkspaces.clear();
    nextPort = DEFAULT_PORT + 1;
  },
  getEntry(key: string): WindsurfLangserverEntry | undefined {
    return entries.get(key);
  },
  getEntryByWorkspace(workspacePath: string): WindsurfLangserverEntry | undefined {
    return entries.get(workspacePath);
  },
};
