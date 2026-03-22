import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ClockConfigSnapshot, ClockNtpState } from './types.js';
import { ensureDir, readSessionDirEnv, resolveClockNtpStateFile } from './paths.js';
import { readJsonFile, writeJsonFileAtomic } from './io.js';
import { getClockOffsetMs, setClockOffsetMs, nowMs as correctedNowMs } from './state.js';

const DEFAULT_NTP_SERVERS = ['time.google.com', 'time.cloudflare.com', 'pool.ntp.org'] as const;

function isNtpDisabledByEnv(): boolean {
  const raw = String(process.env.ROUTECODEX_CLOCK_NTP || '').trim().toLowerCase();
  if (!raw) return false;
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'disable' || raw === 'disabled';
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return err.message || err.name;
    return String(err ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

function formatOffset(minutesEast: number): string {
  const sign = minutesEast >= 0 ? '+' : '-';
  const abs = Math.abs(minutesEast);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${sign}${pad2(hh)}:${pad2(mm)}`;
}

export function resolveServerTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim().length ? tz.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const mmm = pad3(d.getMilliseconds());
  const minutesEast = -d.getTimezoneOffset();
  return `${y}-${mo}-${da} ${hh}:${mi}:${ss}.${mmm} ${formatOffset(minutesEast)}`;
}

export function buildTimeTagLine(snapshot: ClockTimeSnapshot): string {
  // Markdown inline code blocks to reduce the chance of models "roleplaying" XML-like tags.
  // `timeRef=now` 明确声明这是“当前时刻”快照，避免模型将时间标签误读为待查询目标时间。
  return `[Time/Date]: timeRef=\`now\` utc=\`${snapshot.utc}\` local=\`${snapshot.local}\` tz=\`${snapshot.timezone}\` nowMs=\`${snapshot.nowMs}\` ntpOffsetMs=\`${snapshot.ntp.offsetMs}\``;
}

export type ClockTimeSnapshot = {
  active: boolean;
  nowMs: number;
  utc: string;
  local: string;
  timezone: string;
  ntp: ClockNtpState;
};

const EMPTY_NTP_STATE: ClockNtpState = {
  version: 1,
  offsetMs: 0,
  updatedAtMs: 0,
  status: 'stale'
};

let loaded = false;
let state: ClockNtpState = { ...EMPTY_NTP_STATE };
let syncing: Promise<void> | null = null;

function coerceNtpState(raw: unknown): ClockNtpState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_NTP_STATE };
  }
  const r = raw as Record<string, unknown>;
  const offsetMs = typeof r.offsetMs === 'number' && Number.isFinite(r.offsetMs) ? Math.floor(r.offsetMs) : 0;
  const updatedAtMs = typeof r.updatedAtMs === 'number' && Number.isFinite(r.updatedAtMs) ? Math.floor(r.updatedAtMs) : 0;
  const statusRaw = typeof r.status === 'string' ? r.status.trim() : '';
  const status: ClockNtpState['status'] =
    statusRaw === 'synced' || statusRaw === 'stale' || statusRaw === 'error' || statusRaw === 'disabled'
      ? (statusRaw as any)
      : updatedAtMs > 0
        ? 'stale'
        : 'stale';
  const source = typeof r.source === 'string' && r.source.trim().length ? r.source.trim() : undefined;
  const rttMs = typeof r.rttMs === 'number' && Number.isFinite(r.rttMs) ? Math.max(0, Math.floor(r.rttMs)) : undefined;
  const lastError = typeof r.lastError === 'string' && r.lastError.trim().length ? r.lastError.trim() : undefined;
  return { version: 1, offsetMs, updatedAtMs, status, ...(source ? { source } : {}), ...(rttMs !== undefined ? { rttMs } : {}), ...(lastError ? { lastError } : {}) };
}

async function loadStateOnce(): Promise<void> {
  if (loaded) return;
  loaded = true;

  if (isNtpDisabledByEnv()) {
    state = { ...EMPTY_NTP_STATE, status: 'disabled' };
    setClockOffsetMs(0);
    return;
  }

  const sessionDir = readSessionDirEnv();
  if (!sessionDir) {
    state = { ...EMPTY_NTP_STATE, status: 'stale' };
    setClockOffsetMs(0);
    return;
  }
  const filePath = resolveClockNtpStateFile(sessionDir);
  try {
    const raw = await readJsonFile(filePath);
    state = coerceNtpState(raw);
    setClockOffsetMs(state.offsetMs);
  } catch {
    // missing/unreadable file: keep defaults
    state = { ...EMPTY_NTP_STATE, status: 'stale' };
    setClockOffsetMs(0);
  }
}

async function persistState(next: ClockNtpState): Promise<void> {
  const sessionDir = readSessionDirEnv();
  if (!sessionDir) return;
  const filePath = resolveClockNtpStateFile(sessionDir);
  await ensureDir(path.dirname(filePath));
  try {
    await fs.chmod(path.dirname(filePath), 0o700);
  } catch {
    // best-effort
  }
  await writeJsonFileAtomic(filePath, next);
}

const NTP_EPOCH_OFFSET_SECONDS = 2208988800; // 1900-01-01 to 1970-01-01

function msToNtpTimestamp(ms: number): { seconds: number; fraction: number } {
  const seconds = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_SECONDS;
  const msRemainder = ms % 1000;
  const fraction = Math.floor((msRemainder / 1000) * 2 ** 32);
  return { seconds, fraction };
}

function ntpTimestampToMs(seconds: number, fraction: number): number {
  const unixSeconds = seconds - NTP_EPOCH_OFFSET_SECONDS;
  const fracMs = Math.round((fraction / 2 ** 32) * 1000);
  return unixSeconds * 1000 + fracMs;
}

async function querySntpOnce(server: string, timeoutMs: number): Promise<{ offsetMs: number; rttMs: number }> {
  const socket = dgram.createSocket('udp4');
  const req = Buffer.alloc(48);
  req[0] = 0x23; // LI=0, VN=4, Mode=3 (client)

  const t1SystemMs = Date.now();
  const t1 = msToNtpTimestamp(t1SystemMs);
  req.writeUInt32BE(t1.seconds >>> 0, 40);
  req.writeUInt32BE(t1.fraction >>> 0, 44);

  const res = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('ntp timeout'));
    }, timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.once('message', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });

    socket.send(req, 123, server, (err) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }).finally(() => {
    try {
      socket.close();
    } catch {
      // ignore
    }
  });

  if (!Buffer.isBuffer(res) || res.length < 48) {
    throw new Error('invalid ntp response');
  }

  const t4SystemMs = Date.now();
  const t2Seconds = res.readUInt32BE(32);
  const t2Fraction = res.readUInt32BE(36);
  const t3Seconds = res.readUInt32BE(40);
  const t3Fraction = res.readUInt32BE(44);

  const t2Ms = ntpTimestampToMs(t2Seconds, t2Fraction);
  const t3Ms = ntpTimestampToMs(t3Seconds, t3Fraction);

  const offsetMs = ((t2Ms - t1SystemMs) + (t3Ms - t4SystemMs)) / 2;
  const rttMs = (t4SystemMs - t1SystemMs) - (t3Ms - t2Ms);
  return {
    offsetMs: Math.floor(clampNumber(offsetMs, -24 * 60 * 60_000, 24 * 60 * 60_000)),
    rttMs: Math.max(0, Math.floor(rttMs))
  };
}

function resolveNtpServers(): string[] {
  const raw = String(process.env.ROUTECODEX_CLOCK_NTP_SERVERS || '').trim();
  if (!raw) return [...DEFAULT_NTP_SERVERS];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_NTP_SERVERS];
}

export async function syncClockWithNtpOnce(): Promise<void> {
  await loadStateOnce();
  if (isNtpDisabledByEnv()) {
    state = { ...state, status: 'disabled', offsetMs: 0 };
    setClockOffsetMs(0);
    return;
  }
  const servers = resolveNtpServers();
  const timeoutMs = (() => {
    const raw = Number(process.env.ROUTECODEX_CLOCK_NTP_TIMEOUT_MS ?? 800);
    return Number.isFinite(raw) ? Math.max(100, Math.floor(raw)) : 800;
  })();

  let lastErr: string | undefined;
  for (const server of servers.slice(0, 5)) {
    try {
      const result = await querySntpOnce(server, timeoutMs);
      const updatedAtMs = Date.now();
      const next: ClockNtpState = {
        version: 1,
        offsetMs: result.offsetMs,
        updatedAtMs,
        source: server,
        rttMs: result.rttMs,
        status: 'synced'
      };
      state = next;
      setClockOffsetMs(result.offsetMs);
      await persistState(next);
      return;
    } catch (err) {
      lastErr = safeErrorMessage(err);
    }
  }

  state = {
    ...state,
    status: 'error',
    lastError: lastErr || 'ntp failed',
    updatedAtMs: state.updatedAtMs || Date.now()
  };
}

export async function startClockNtpSyncIfNeeded(_config?: ClockConfigSnapshot): Promise<void> {
  await loadStateOnce();
  if (isNtpDisabledByEnv()) return;
  if (syncing) return syncing;
  // Best-effort background sync; do not block the request pipeline.
  syncing = (async () => {
    try {
      await syncClockWithNtpOnce();
    } catch {
      // best-effort
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

export async function getClockNtpState(): Promise<ClockNtpState> {
  await loadStateOnce();
  const now = Date.now();
  const staleAfterMs = (() => {
    const raw = Number(process.env.ROUTECODEX_CLOCK_NTP_STALE_AFTER_MS ?? 6 * 60 * 60_000);
    return Number.isFinite(raw) ? Math.max(60_000, Math.floor(raw)) : 6 * 60 * 60_000;
  })();
  const age = state.updatedAtMs > 0 ? Math.max(0, now - state.updatedAtMs) : Number.POSITIVE_INFINITY;
  if (state.status === 'synced' && age > staleAfterMs) {
    return { ...state, status: 'stale' };
  }
  return { ...state };
}

export async function getClockTimeSnapshot(): Promise<ClockTimeSnapshot> {
  await loadStateOnce();
  const now = correctedNowMs();
  const d = new Date(now);
  const utc = (() => {
    try {
      return d.toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  })();
  const timezone = resolveServerTimezone();
  const local = formatLocalTime(now);
  const ntp = await getClockNtpState();
  return {
    active: true,
    nowMs: now,
    utc,
    local,
    timezone,
    ntp
  };
}

export function getCurrentClockOffsetMs(): number {
  return getClockOffsetMs();
}

export function buildStableToolCallId(prefix: string = 'call_clock'): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}
