import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export type ServerToolRuntimeState = {
  enabled: boolean;
  updatedAtMs: number;
  updatedBy: string;
};

export type ServerToolLogDetail = {
  ts: string;
  requestId: string;
  flowId: string;
  tool: string;
  stage: string;
  result: string;
  message: string;
  status: 'success' | 'failure' | 'running' | 'info';
  entryEndpoint?: string;
  providerProtocol?: string;
};

export type ServerToolToolStats = {
  tool: string;
  executions: number;
  success: number;
  failure: number;
  lastSeenTs?: string;
};

export type ServerToolStatsSnapshot = {
  logPath: string;
  logExists: boolean;
  scannedLines: number;
  executions: number;
  success: number;
  failure: number;
  byTool: ServerToolToolStats[];
  recent: ServerToolLogDetail[];
};

type ProgressLogEvent = {
  ts?: unknown;
  requestId?: unknown;
  flowId?: unknown;
  tool?: unknown;
  stage?: unknown;
  result?: unknown;
  message?: unknown;
  entryEndpoint?: unknown;
  providerProtocol?: unknown;
};

const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_LOG_PATH = path.join(homedir(), '.routecodex', 'logs', 'servertool-events.jsonl');
const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINES = 3000;
const DEFAULT_RECENT_EVENTS = 120;

const runtimeState: ServerToolRuntimeState = {
  enabled: true,
  updatedAtMs: Date.now(),
  updatedBy: 'default'
};

function resolveDefaultEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_SERVERTOOL_ENABLED ??
      process.env.RCC_SERVERTOOL_ENABLED ??
      process.env.LLMSWITCH_SERVERTOOL_ENABLED ??
      ''
  )
    .trim()
    .toLowerCase();
  if (truthy.has(raw)) {
    return true;
  }
  if (falsy.has(raw)) {
    return false;
  }
  return true;
}

runtimeState.enabled = resolveDefaultEnabled();

export function getServerToolRuntimeState(): ServerToolRuntimeState {
  return { ...runtimeState };
}

export function isServerToolEnabled(): boolean {
  return runtimeState.enabled;
}

export function setServerToolEnabled(enabled: boolean, updatedBy = 'daemon-admin'): ServerToolRuntimeState {
  runtimeState.enabled = enabled;
  runtimeState.updatedAtMs = Date.now();
  runtimeState.updatedBy = updatedBy;
  return getServerToolRuntimeState();
}

function resolveLogPath(): string {
  const raw = String(
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH ??
      process.env.RCC_SERVERTOOL_FILE_LOG_PATH ??
      process.env.LLMSWITCH_SERVERTOOL_FILE_LOG_PATH ??
      ''
  ).trim();
  return raw || DEFAULT_LOG_PATH;
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEventStatus(stage: string, result: string): 'success' | 'failure' | 'running' | 'info' {
  if (stage === 'final') {
    return result.startsWith('completed') ? 'success' : 'failure';
  }
  if (stage === 'match' && result === 'matched') {
    return 'running';
  }
  return 'info';
}

function classifyExecutionStart(event: ServerToolLogDetail): boolean {
  return event.stage === 'match' && event.result === 'matched' && event.tool !== 'none';
}

function classifyExecutionSuccess(event: ServerToolLogDetail): boolean {
  return event.stage === 'final' && event.result.startsWith('completed') && event.tool !== 'none';
}

function readTailText(filePath: string, maxBytes = DEFAULT_MAX_TAIL_BYTES): string {
  const stat = fs.statSync(filePath);
  if (!Number.isFinite(stat.size) || stat.size <= 0) {
    return '';
  }
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLogEvent(line: string): ServerToolLogDetail | null {
  if (!line.trim()) {
    return null;
  }
  let parsed: ProgressLogEvent;
  try {
    parsed = JSON.parse(line) as ProgressLogEvent;
  } catch {
    return null;
  }
  const tool = coerceString(parsed.tool) || 'unknown';
  const stage = coerceString(parsed.stage) || 'unknown';
  const result = coerceString(parsed.result) || 'unknown';
  const requestId = coerceString(parsed.requestId) || 'unknown';
  const message = coerceString(parsed.message);
  const flowId = coerceString(parsed.flowId);
  const ts = coerceString(parsed.ts);
  return {
    ts: ts || new Date(0).toISOString(),
    requestId,
    flowId,
    tool,
    stage,
    result,
    message,
    status: normalizeEventStatus(stage, result),
    ...(coerceString(parsed.entryEndpoint) ? { entryEndpoint: coerceString(parsed.entryEndpoint) } : {}),
    ...(coerceString(parsed.providerProtocol) ? { providerProtocol: coerceString(parsed.providerProtocol) } : {})
  };
}

function getToolStats(
  table: Map<string, { executions: number; success: number; finalFailure: number; lastSeenTs?: string }>,
  tool: string
): { executions: number; success: number; finalFailure: number; lastSeenTs?: string } {
  let stats = table.get(tool);
  if (!stats) {
    stats = { executions: 0, success: 0, finalFailure: 0 };
    table.set(tool, stats);
  }
  return stats;
}

export function readServerToolStatsSnapshot(options?: {
  maxLines?: number;
  maxTailBytes?: number;
  recentLimit?: number;
}): ServerToolStatsSnapshot {
  const logPath = resolveLogPath();
  if (!fs.existsSync(logPath)) {
    return {
      logPath,
      logExists: false,
      scannedLines: 0,
      executions: 0,
      success: 0,
      failure: 0,
      byTool: [],
      recent: []
    };
  }

  const maxLines = Number.isFinite(options?.maxLines) ? Math.max(50, Math.floor(options!.maxLines!)) : DEFAULT_MAX_LINES;
  const maxTailBytes = Number.isFinite(options?.maxTailBytes)
    ? Math.max(32 * 1024, Math.floor(options!.maxTailBytes!))
    : DEFAULT_MAX_TAIL_BYTES;
  const recentLimit = Number.isFinite(options?.recentLimit)
    ? Math.max(20, Math.floor(options!.recentLimit!))
    : DEFAULT_RECENT_EVENTS;

  const text = readTailText(logPath, maxTailBytes);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const sliced = lines.slice(-maxLines);
  const events: ServerToolLogDetail[] = [];
  for (const line of sliced) {
    const event = parseLogEvent(line);
    if (event) {
      events.push(event);
    }
  }

  let executions = 0;
  let success = 0;
  const toolTable = new Map<string, { executions: number; success: number; finalFailure: number; lastSeenTs?: string }>();

  for (const event of events) {
    if (event.tool === 'none') {
      continue;
    }
    const toolStats = getToolStats(toolTable, event.tool);
    if (!toolStats.lastSeenTs || event.ts > toolStats.lastSeenTs) {
      toolStats.lastSeenTs = event.ts;
    }
    if (classifyExecutionStart(event)) {
      executions += 1;
      toolStats.executions += 1;
    }
    if (classifyExecutionSuccess(event)) {
      success += 1;
      toolStats.success += 1;
    } else if (event.stage === 'final' && event.tool !== 'none') {
      toolStats.finalFailure += 1;
    }
  }

  const failure = Math.max(executions - success, 0);
  const byTool: ServerToolToolStats[] = Array.from(toolTable.entries())
    .map(([tool, stats]) => ({
      tool,
      executions: stats.executions,
      success: stats.success,
      failure: Math.max(stats.executions - stats.success, stats.finalFailure),
      ...(stats.lastSeenTs ? { lastSeenTs: stats.lastSeenTs } : {})
    }))
    .sort((a, b) => {
      if (b.executions !== a.executions) {
        return b.executions - a.executions;
      }
      return a.tool.localeCompare(b.tool);
    });

  const recent = events.slice(-recentLimit).reverse();

  return {
    logPath,
    logExists: true,
    scannedLines: events.length,
    executions,
    success,
    failure,
    byTool,
    recent
  };
}
