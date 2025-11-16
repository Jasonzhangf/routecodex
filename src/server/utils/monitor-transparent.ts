import fs from 'fs';
import os from 'os';
import path from 'path';

interface TransparentMonitorConfig {
  enabled: boolean;
  upstreamUrl?: string;
  authHeader?: string;
  timeoutMs?: number;
}

let cachedConfig: TransparentMonitorConfig | null = null;
let lastLoaded = 0;
const CACHE_TTL_MS = 5_000;

export function getTransparentMonitorConfigForResponses(): TransparentMonitorConfig {
  // 仅在显式启用监控时才生效
  if (String(process.env.ROUTECODEX_MONITOR_ENABLED || '') !== '1') {
    return { enabled: false };
  }

  const now = Date.now();
  if (cachedConfig && now - lastLoaded < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const home = os.homedir();
  const monPath = path.join(home, '.routecodex', 'monitor.json');

  try {
    if (!fs.existsSync(monPath)) {
      cachedConfig = { enabled: false };
      lastLoaded = now;
      return cachedConfig;
    }
    const raw = fs.readFileSync(monPath, 'utf8');
    const j = JSON.parse(raw || '{}');
    const t = j?.transparent || {};
    if (!t.enabled) {
      cachedConfig = { enabled: false };
      lastLoaded = now;
      return cachedConfig;
    }

    const base = String(t.endpoints?.openai || '').trim();
    if (!base) {
      cachedConfig = { enabled: false };
      lastLoaded = now;
      return cachedConfig;
    }

    // 统一构造 /responses 端点
    const upstreamUrl = base.replace(/\/+$/, '') + '/responses';

    // 认证头：auth.openai = "env:FC_API_KEY" 之类
    let authHeader: string | undefined;
    const authSpec = String(t.auth?.openai || '').trim();
    if (authSpec.startsWith('env:')) {
      const envName = authSpec.slice(4);
      const val = process.env[envName];
      if (val && val.trim().length > 0) {
        authHeader = `Bearer ${val.trim()}`;
      }
    }

    const timeoutMs = typeof t.timeoutMs === 'number' && t.timeoutMs > 0 ? t.timeoutMs : 15000;

    cachedConfig = {
      enabled: true,
      upstreamUrl,
      authHeader,
      timeoutMs
    };
    lastLoaded = now;
    return cachedConfig;
  } catch {
    cachedConfig = { enabled: false };
    lastLoaded = now;
    return cachedConfig;
  }
}

