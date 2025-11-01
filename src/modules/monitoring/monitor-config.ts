import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type MonitorMode = 'off' | 'passive' | 'transparent';

export interface TransparentUpstreamConfig {
  enabled?: boolean;
  defaultUpstream?: 'openai' | 'anthropic';
  endpoints?: { openai?: string; anthropic?: string };
  auth?: { openai?: string; anthropic?: string };
  authorization?: string;
  headerAllowlist?: string[];
  timeoutMs?: number;
  preferClientHeaders?: boolean;
  // Optional: remap client-sent model name to upstream-specific model id
  modelMapping?: Record<string, string>;
  // Optional: prefer a specific wire API for upstream ('chat' | 'responses')
  wireApi?: 'chat' | 'responses';
  // Optional: extra headers to attach to upstream requests (key as-is)
  extraHeaders?: Record<string, string>;
}

export interface MonitorFileConfig {
  mode?: MonitorMode;
  transparent?: TransparentUpstreamConfig;
}

function home(): string { return os.homedir(); }

function monitorPath(): string {
  return path.join(home(), '.routecodex', 'monitor.json');
}

function parseMaybeEnv(val?: string): string | undefined {
  if (!val) {return undefined;}
  const s = String(val).trim();
  if (s.toLowerCase().startsWith('env:')) {
    const key = s.slice(4).trim();
    return (process.env[key] || '').trim() || undefined;
  }
  return s;
}

export class MonitorConfigUtil {
  private static cache: { ts: number; data: MonitorFileConfig | null } = { ts: 0, data: null };
  private static ttlMs = 2000;

  static filePath(): string { return monitorPath(); }

  static async load(): Promise<MonitorFileConfig | null> {
    try {
      const p = monitorPath();
      if (!fss.existsSync(p)) { return null; }
      const now = Date.now();
      if (this.cache.data && (now - this.cache.ts) < this.ttlMs) {
        return this.cache.data;
      }
      const raw = await fs.readFile(p, 'utf-8');
      const json = JSON.parse(raw) as MonitorFileConfig;
      this.cache = { ts: now, data: json };
      return json;
    } catch { return null; }
  }

  static isTransparentEnabled(cfg?: MonitorFileConfig | null): boolean {
    if (process.env.ROUTECODEX_MONITOR_TRANSPARENT === '1' || process.env.ROUTECODEX_ANALYSIS_TRANSPARENT === '1') {
      return true;
    }
    const c = cfg || null;
    if (!c) {return false;}
    if (c.mode === 'transparent') {return true;}
    if (c.transparent && c.transparent.enabled) {return true;}
    return false;
  }

  static getTransparent(cfg?: MonitorFileConfig | null): TransparentUpstreamConfig | null {
    const c = cfg || null;
    const envOpenAI = process.env.ROUTECODEX_TRANSPARENT_OPENAI || process.env.ROUTECODEX_MONITOR_UPSTREAM_OPENAI;
    const envAnthropic = process.env.ROUTECODEX_TRANSPARENT_ANTHROPIC || process.env.ROUTECODEX_MONITOR_UPSTREAM_ANTHROPIC;
  const base: TransparentUpstreamConfig = {
    enabled: this.isTransparentEnabled(c),
    defaultUpstream: (c?.transparent?.defaultUpstream as any) || undefined,
    endpoints: {
      openai: c?.transparent?.endpoints?.openai || envOpenAI || undefined,
      anthropic: c?.transparent?.endpoints?.anthropic || envAnthropic || undefined,
    },
    auth: {
      openai: parseMaybeEnv(c?.transparent?.auth?.openai),
      anthropic: parseMaybeEnv(c?.transparent?.auth?.anthropic),
    },
    authorization: parseMaybeEnv(c?.transparent?.authorization),
      headerAllowlist: c?.transparent?.headerAllowlist || ['accept','content-type','anthropic-version','x-*'],
      timeoutMs: typeof c?.transparent?.timeoutMs === 'number' ? c!.transparent!.timeoutMs : 30000,
      preferClientHeaders: c?.transparent?.preferClientHeaders !== false,
      modelMapping: (c?.transparent?.modelMapping && typeof c.transparent.modelMapping === 'object') ? (c.transparent.modelMapping as Record<string, string>) : undefined,
      wireApi: (c?.transparent?.wireApi === 'responses' ? 'responses' : (c?.transparent?.wireApi === 'chat' ? 'chat' : undefined))
      ,extraHeaders: (c?.transparent?.extraHeaders && typeof c.transparent.extraHeaders === 'object') ? (c.transparent.extraHeaders as Record<string,string>) : undefined
    };
    return base;
  }
}
