import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

type SpawnSyncLike = typeof nodeSpawnSync;

export type ManagedZombieProcess = {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
};

export function resolveManagedServerPidFiles(port: number, routeCodexHomeDir?: string): string[] {
  const home = routeCodexHomeDir || path.join(homedir(), '.routecodex');
  return [
    path.join(home, `server-${port}.pid`)
  ];
}

function tryReadPid(filePath: string): number | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = Number(String(raw || '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number, processKill: typeof process.kill = process.kill.bind(process)): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    processKill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number, spawnSyncImpl: SpawnSyncLike): string {
  if (process.platform === 'win32') {
    return '';
  }
  try {
    const result = spawnSyncImpl('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (result.error || Number(result.status ?? 0) !== 0) {
      return '';
    }
    return String(result.stdout || '').trim();
  } catch {
    return '';
  }
}

function parseEnvPortFromCommand(command: string): number | null {
  const text = String(command || '');
  const patterns = [
    /(?:^|\s)ROUTECODEX_PORT=(\d+)(?:\s|$)/,
    /(?:^|\s)RCC_PORT=(\d+)(?:\s|$)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function listListeningPidsByPort(port: number, spawnSyncImpl: SpawnSyncLike): number[] {
  if (!Number.isFinite(port) || port <= 0 || process.platform === 'win32') {
    return [];
  }

  try {
    const result = spawnSyncImpl(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8' }
    );
    if (result.error || Number(result.status ?? 0) !== 0) {
      return [];
    }
    const out: number[] = [];
    const seen = new Set<number>();
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const pid = Number.parseInt(line, 10);
      if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      out.push(pid);
    }
    return out;
  } catch {
    return [];
  }
}

export function isTrustedRouteCodexCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('routecodex/dist/index.js')) {
    return true;
  }
  if (normalized.includes('@jsonstudio/rcc') && normalized.includes('/dist/index.js')) {
    return true;
  }
  if (normalized.includes('jsonstudio-rcc') && normalized.includes('/dist/index.js')) {
    return true;
  }
  return false;
}

export function listManagedServerPidsByPort(
  port: number,
  options: {
    routeCodexHomeDir?: string;
    processKill?: typeof process.kill;
    spawnSyncImpl?: SpawnSyncLike;
  } = {}
): number[] {
  const processKill = options.processKill ?? process.kill.bind(process);
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const files = resolveManagedServerPidFiles(port, options.routeCodexHomeDir);
  const seen = new Set<number>();
  const out: number[] = [];

  const maybeAcceptPid = (pid: number): void => {
    if (!pid || seen.has(pid)) {
      return;
    }
    if (!isPidAlive(pid, processKill)) {
      return;
    }
    if (process.platform !== 'win32') {
      const command = readProcessCommand(pid, spawnSyncImpl);
      if (!isTrustedRouteCodexCommand(command)) {
        return;
      }
      const envPort = parseEnvPortFromCommand(command);
      if (typeof envPort === 'number' && Number.isFinite(envPort) && envPort > 0 && envPort !== port) {
        return;
      }
    }
    seen.add(pid);
    out.push(pid);
  };

  for (const filePath of files) {
    const pid = tryReadPid(filePath);
    maybeAcceptPid(pid ?? 0);
  }

  // Fallback for stale/missing pid files: discover listeners by port and
  // keep only trusted RouteCodex/RCC commands.
  const listeningPids = listListeningPidsByPort(port, spawnSyncImpl);
  for (const pid of listeningPids) {
    maybeAcceptPid(pid);
  }

  return out;
}

function parseZombieProcessesFromPsOutput(output: string): ManagedZombieProcess[] {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const out: ManagedZombieProcess[] = [];
  const seen = new Set<number>();

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const stat = String(match[3] || '').trim();
    const command = String(match[4] || '').trim();

    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      continue;
    }
    if (!stat.startsWith('Z')) {
      continue;
    }
    if (seen.has(pid)) {
      continue;
    }

    out.push({ pid, ppid, stat, command });
    seen.add(pid);
  }

  return out;
}

export function listZombieChildrenByParentPids(
  parentPids: number[],
  options: {
    spawnSyncImpl?: SpawnSyncLike;
  } = {}
): ManagedZombieProcess[] {
  if (process.platform === 'win32') {
    return [];
  }

  const parentSet = new Set(
    (Array.isArray(parentPids) ? parentPids : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  if (parentSet.size === 0) {
    return [];
  }

  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  try {
    const result = spawnSyncImpl('ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' });
    if (result.error || Number(result.status ?? 0) !== 0) {
      return [];
    }

    const zombies = parseZombieProcessesFromPsOutput(String(result.stdout || ''));
    return zombies.filter((item) => parentSet.has(item.ppid));
  } catch {
    return [];
  }
}

export function listManagedServerZombieChildrenByPort(
  port: number,
  options: {
    routeCodexHomeDir?: string;
    processKill?: typeof process.kill;
    spawnSyncImpl?: SpawnSyncLike;
  } = {}
): ManagedZombieProcess[] {
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const managedParentPids = listManagedServerPidsByPort(port, {
    routeCodexHomeDir: options.routeCodexHomeDir,
    processKill: options.processKill,
    spawnSyncImpl
  });

  return listZombieChildrenByParentPids(managedParentPids, { spawnSyncImpl });
}
