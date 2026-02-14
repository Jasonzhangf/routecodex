/**
 * Process Snapshot Utilities
 *
 * Functions for reading process information and resolving signal callers.
 */

import { spawnSync } from 'child_process';
import { getShutdownCallerContext } from '../utils/shutdown-caller-context.js';
import { truncateLogValue, collectEnvHints } from '../app/config-readers.js';

type ProcessSnapshot = {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  tty: string;
  stat: string;
  etime: string;
  command: string;
};

type SessionPeer = {
  pid: number;
  ppid: number;
  sid: number;
  command: string;
};

function readProcessSnapshot(pid: number): ProcessSnapshot | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const ps = spawnSync(
      'ps',
      ['-o', 'pid=,ppid=,pgid=,sess=,tty=,stat=,etime=,command=', '-p', String(pid)],
      { encoding: 'utf8' }
    );
    const line = String(ps.stdout || '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (!line) {
      return undefined;
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) {
      return undefined;
    }
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      sid: Number(match[4]),
      tty: match[5],
      stat: match[6],
      etime: match[7],
      command: truncateLogValue(match[8].trim(), 360)
    };
  } catch {
    return undefined;
  }
}

function listSessionPeers(sessionId: number, currentPid: number): SessionPeer[] {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return [];
  }
  try {
    const ps = spawnSync('ps', ['-o', 'pid=,ppid=,sess=,command=', '-ax'], { encoding: 'utf8' });
    const lines = String(ps.stdout || '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const peers: SessionPeer[] = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const sid = Number(match[3]);
      const command = (match[4] || '').trim();
      if (sid !== sessionId || pid === currentPid) {
        continue;
      }
      if (!/(routecodex|codex|claude|node|iterm|terminal|tmux)/i.test(command)) {
        continue;
      }
      peers.push({
        pid,
        ppid,
        sid,
        command: truncateLogValue(command, 280)
      });
      if (peers.length >= 24) {
        break;
      }
    }
    return peers;
  } catch {
    return [];
  }
}

function resolveSignalCaller(signal: string): Record<string, unknown> {
  const observedTs = new Date().toISOString();
  const fromShutdownRoute = getShutdownCallerContext({ maxAgeMs: 10 * 60 * 1000 });
  const selfSnapshot = readProcessSnapshot(process.pid);
  const parentSnapshot = readProcessSnapshot(process.ppid);
  const grandParentSnapshot = parentSnapshot ? readProcessSnapshot(parentSnapshot.ppid) : undefined;
  const sessionId = selfSnapshot?.sid ?? parentSnapshot?.sid;
  const sessionPeers = typeof sessionId === 'number' ? listSessionPeers(sessionId, process.pid) : [];
  const terminalEnv = collectEnvHints([
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TERM_SESSION_ID',
    'ITERM_SESSION_ID',
    'ITERM_PROFILE',
    'ITERM_ORIGIN_APP',
    'SHELL',
    'TMUX',
    'TMUX_PANE',
    'VSCODE_PID',
    'SSH_CONNECTION',
    'ROUTECODEX_PORT',
    'RCC_PORT'
  ]);

  const base: Record<string, unknown> = {
    signal,
    observedTs,
    processPid: process.pid,
    processPpid: process.ppid,
    runtime: {
      platform: process.platform,
      node: process.version,
      execPath: process.execPath,
      cwd: process.cwd(),
      uptimeSec: Math.floor(process.uptime()),
      argv: process.argv.slice(0, 10).map((entry) => truncateLogValue(String(entry), 240))
    },
    terminalEnv,
    processTree: {
      self: selfSnapshot,
      parent: parentSnapshot,
      grandparent: grandParentSnapshot
    },
    sessionPeers
  };

  if (fromShutdownRoute) {
    return {
      callerType: 'shutdown_route_context',
      ...base,
      ...fromShutdownRoute
    };
  }

  return {
    callerType: 'unknown_signal_sender',
    ...base,
    parentCommand: parentSnapshot?.command || ''
  };
}

export { readProcessSnapshot, listSessionPeers, resolveSignalCaller };
export type { ProcessSnapshot, SessionPeer };
