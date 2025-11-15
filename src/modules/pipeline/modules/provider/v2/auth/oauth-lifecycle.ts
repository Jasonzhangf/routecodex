import type { OAuthAuth } from '../api/provider-config.js';
import { createProviderOAuthStrategy, getProviderOAuthConfig } from '../config/provider-oauth-configs.js';
import { OAuthFlowType } from '../config/oauth-flows.js';
import fs from 'fs/promises';
import path from 'path';

type EnsureOpts = {
  forceReacquireIfRefreshFails?: boolean;
  openBrowser?: boolean;
  forceReauthorize?: boolean;
};

// Simple in-process locks to avoid concurrent interactive flows
const inFlight: Map<string, Promise<void>> = new Map();
const lastRunAt: Map<string, number> = new Map();

function keyFor(providerType: string, tokenFile?: string): string {
  return `${providerType}::${tokenFile || ''}`;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? p.replace(/^~\//, `${process.env.HOME || ''}/`) : p;
}

function defaultTokenFile(providerType: string): string {
  const home = process.env.HOME || '';
  // 对齐 iFlow CLI 的默认位置
  if (providerType === 'iflow') {
    return path.join(home, '.iflow', 'oauth_creds.json');
  }
  // Qwen: 按配置体系约定，OAuth 凭证默认放在 ~/.routecodex/auth 目录
  if (providerType === 'qwen') {
    return path.join(home, '.routecodex', 'auth', 'qwen-oauth.json');
  }
  return path.join(home, '.routecodex', 'tokens', `${providerType}-default.json`);
}

function resolveTokenFilePath(auth: OAuthAuth, providerType: string): string {
  const tf = (auth as any).tokenFile as string | undefined;
  const resolved = tf && tf.trim() ? expandHome(tf.trim()) : defaultTokenFile(providerType);
  // 将最终路径回写到配置中，确保 TokenFileAuthProvider / OAuthAuthProvider 等后续组件
  // 使用同一份 tokenFile 设置，避免出现多处默认路径不一致的问题。
  if (!tf || !tf.trim()) {
    (auth as any).tokenFile = resolved;
  }
  return resolved;
}

function shouldThrottle(k: string, ms = 60_000): boolean {
  const t = lastRunAt.get(k) || 0;
  return Date.now() - t < ms;
}

export async function ensureValidOAuthToken(
  providerType: string,
  auth: OAuthAuth,
  opts: EnsureOpts = {}
): Promise<void> {
  // Non-oauth callers should not route here
  if (!auth || auth.type !== 'oauth') return;

  const tokenFilePath = resolveTokenFilePath(auth, providerType);
  const k = keyFor(providerType, tokenFilePath);
  if (inFlight.has(k)) {
    await inFlight.get(k)!;
    return;
  }
  if (shouldThrottle(k)) return; // avoid excessive work

  const openBrowser = opts.openBrowser ?? (String(process.env.ROUTECODEX_OAUTH_AUTO_OPEN || '1') === '1');
  const forceReauth = opts.forceReauthorize === true || String(process.env.ROUTECODEX_OAUTH_FORCE_REAUTH || '0') === '1';
  const p = (async () => {
    try {
      // 1) 构建策略（Provider默认配置 + 用户覆盖）
      const defaults: any = getProviderOAuthConfig(providerType);
      const ep: any = { ...(defaults?.endpoints || {}) };
      if (auth.tokenUrl) ep.tokenUrl = auth.tokenUrl;
      if (auth.deviceCodeUrl) ep.deviceCodeUrl = auth.deviceCodeUrl;
      if ((auth as any).authorizationUrl) ep.authorizationUrl = (auth as any).authorizationUrl;
      if ((auth as any).userInfoUrl) ep.userInfoUrl = (auth as any).userInfoUrl;
      const client: any = { ...(defaults?.client || {}) };
      if (auth.clientId) client.clientId = auth.clientId;
      if (auth.clientSecret) client.clientSecret = auth.clientSecret;
      if (Array.isArray(auth.scopes)) client.scopes = auth.scopes;
      if ((auth as any).redirectUri) client.redirectUri = (auth as any).redirectUri;
      // iflow: 允许通过环境变量或捕获的 CLI 日志自动注入 clientId/secret（避免硬编码）
      if (providerType === 'iflow') {
        try {
          const envId = process.env.IFLOW_CLIENT_ID?.trim();
          const envSecret = process.env.IFLOW_CLIENT_SECRET?.trim();
          if (envId) client.clientId = envId;
          if (envSecret) client.clientSecret = envSecret;
          if (!client.clientSecret || !client.clientId) {
            const inferred = await inferIflowClientCredsFromLog();
            if (inferred?.clientId && !client.clientId) client.clientId = inferred.clientId;
            if (inferred?.clientSecret && !client.clientSecret) client.clientSecret = inferred.clientSecret;
          }
        } catch { /* ignore */ }
      }
      // iFlow 严格端点与头部（对齐官方客户端）
      if (providerType === 'iflow') {
        try {
          const needPatchDevice = typeof ep.deviceCodeUrl !== 'string' || !/\/api\/oauth2\/device\/code$/.test(ep.deviceCodeUrl);
          const needPatchToken = typeof ep.tokenUrl !== 'string' || !/\/api\/oauth2\/token$/.test(ep.tokenUrl);
          if (needPatchDevice) ep.deviceCodeUrl = 'https://iflow.cn/api/oauth2/device/code';
          if (needPatchToken) ep.tokenUrl = 'https://iflow.cn/api/oauth2/token';
        } catch { /* ignore */ }
      }

      const enforcedHeaders = (providerType === 'iflow') ? {
        'User-Agent': 'iflow-cli/2.0',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://iflow.cn',
        'Referer': 'https://iflow.cn/oauth',
        'Accept': 'application/json'
      } : {};

      const overrides: Record<string, unknown> = {
        activationType: openBrowser ? 'auto_browser' : 'manual',
        endpoints: ep,
        client,
        tokenFile: tokenFilePath,
        headers: { ...(defaults?.headers || {}), ...enforcedHeaders }
      };
      const strat: any = createProviderOAuthStrategy(providerType, overrides, tokenFilePath);

      // 基础日志
      try {
        console.log(`[OAuth] ensureValid: provider=${providerType} flow=${String(defaults?.flowType || 'unknown')} activation=${String(overrides.activationType)} tokenFile=${tokenFilePath} openBrowser=${openBrowser} forceReauth=${forceReauth}`);
        if (ep?.deviceCodeUrl || ep?.authorizationUrl) {
          console.log(`[OAuth] endpoints: deviceCodeUrl=${String(ep.deviceCodeUrl || '')} tokenUrl=${String(ep.tokenUrl || '')} authUrl=${String(ep.authorizationUrl || '')} userInfoUrl=${String(ep.userInfoUrl || '')}`);
        }
        if (providerType === 'iflow') {
          console.log(`[OAuth] iflow client: id=${String(client.clientId || '(missing)')} secret=${client.clientSecret ? '(present)' : '(missing)'} redirect=${String(client.redirectUri || '(default)')}`);
        }
      } catch { /* ignore logging errors */ }

      // 2) 读取本地token，并判断有效性
      const readLocalToken = async () => {
        const tf = tokenFilePath;
        const txt = await fs.readFile(tf, 'utf-8').catch(() => '');
        if (!txt) return null as any;
        try { return JSON.parse(txt); } catch { return null as any; }
      };

      const token = await readLocalToken();
      try {
        const exists = !!token;
        const hasApiKey0 = exists && typeof (token as any).apiKey === 'string' && (token as any).apiKey.trim().length > 0;
        const hasAccess0 = exists && typeof (token as any).access_token === 'string' && (token as any).access_token.trim().length > 0;
        const exp0Raw: any = exists ? ((token as any).expires_at ?? (token as any).expired ?? (token as any).expiry_date) : null;
        console.log(`[OAuth] token.read: exists=${exists} hasApiKey=${hasApiKey0} hasAccess=${hasAccess0} expRaw=${String(exp0Raw)}`);
        if (providerType === 'iflow') {
          console.log(`[OAuth] strict endpoints: deviceCodeUrl=${String(ep.deviceCodeUrl)} tokenUrl=${String(ep.tokenUrl)}`);
        }
      } catch { /* ignore logging errors */ }
      const getExpiresAt = (t: any): number | null => {
        if (!t) return null;
        const raw = (t.expires_at ?? t.expired ?? t.expiry_date) as any;
        if (typeof raw === 'number') return raw;
        if (typeof raw === 'string') {
          const ts = Date.parse(raw);
          return Number.isFinite(ts) ? ts : null;
        }
        return null;
      };
  const now = Date.now();
  const exp = getExpiresAt(token);
  const hasApiKey = token && typeof (token as any).apiKey === 'string' && (token as any).apiKey.trim().length > 0;
  const hasAccess = token && typeof (token as any).access_token === 'string' && (token as any).access_token.trim().length > 0;
  const provider = String(providerType || '').toLowerCase();

  // 令牌是否已过期（或接近过期，留 60s 缓冲）
  const skewMs = 60_000;
  const isExpiredOrNear = (() => {
    if (exp == null) return false;
    return now >= (exp - skewMs);
  })();

  // 判断是否可直接复用本地令牌：
  // - iflow：必须有 apiKey，且不过期；缺少 apiKey 时走设备码流并交换 apiKey
  // - qwen：access_token + 未过期 即视为有效，不强制要求 apiKey（access_token 就是主要凭证）
  // - 其他：优先 apiKey，其次 access_token，只要不过期即可
  let validAccess = false;
  if (provider === 'iflow') {
    validAccess = hasApiKey && !isExpiredOrNear;
  } else if (provider === 'qwen') {
    validAccess = (hasApiKey || hasAccess) && !isExpiredOrNear;
  } else {
    validAccess = (hasApiKey || hasAccess) && !isExpiredOrNear;
  }

  // iFlow 特例：若缺少 apiKey，尝试用现有 access_token 获取 apiKey 后再保存
  // 不做预先 enrichment；缺少 apiKey 必须走设备码授权，一次性获取并保存
  if (!forceReauth && validAccess) {
    console.log(`[OAuth] Using existing token (${hasApiKey ? 'apiKey' : 'access_token'} valid). No authorization required.`);
    lastRunAt.set(k, Date.now());
    return;
  }

  // 3) 近过期/已过期：优先刷新；失败且允许时才走交互授权
  if (!forceReauth && isExpiredOrNear && token?.refresh_token && typeof strat.refreshToken === 'function') {
        try {
          console.log('[OAuth] refreshing token...');
          const refreshed = await strat.refreshToken(token.refresh_token);
          if (typeof strat.saveToken === 'function') {
            await strat.saveToken(refreshed);
            console.log(`[OAuth] Token refreshed and saved: ${tokenFilePath}`);
          }
          lastRunAt.set(k, Date.now());
          return;
        } catch (e) {
          if (opts.forceReacquireIfRefreshFails) {
            console.log('[OAuth] refresh failed, attempting interactive authorization...');
            const authed = await strat.authenticate({ openBrowser });
            if (typeof strat.saveToken === 'function' && authed) {
              await strat.saveToken(authed);
              console.log(`[OAuth] Token acquired and saved: ${tokenFilePath}`);
            }
            lastRunAt.set(k, Date.now());
            return;
          }
          throw e;
        }
      }

      // 4) 无token或不可刷新：进行交互式授权（对齐老方式：iflow 优先授权码，失败再设备码）
      console.log('[OAuth] starting interactive authorization flow...');
      if (providerType === 'iflow') {
        // 4.1 授权码优先
        try {
          const authCodeStrat: any = createProviderOAuthStrategy(providerType, { ...overrides, flowType: OAuthFlowType.AUTHORIZATION_CODE }, tokenFilePath);
          const authed = await authCodeStrat.authenticate({ openBrowser: true });
          if (typeof authCodeStrat.saveToken === 'function' && authed) {
            await authCodeStrat.saveToken(authed);
            console.log(`[OAuth] Token acquired (auth_code) and saved: ${tokenFilePath}`);
          }
          lastRunAt.set(k, Date.now());
          return;
        } catch (e1) {
          console.warn(`[OAuth] auth_code flow failed: ${e1 instanceof Error ? e1.message : String(e1)}`);
          // 4.2 设备码后备（与老方式一致）
          try {
            const deviceStrat: any = createProviderOAuthStrategy(providerType, { ...overrides, flowType: OAuthFlowType.DEVICE_CODE }, tokenFilePath);
            const authed2 = await deviceStrat.authenticate({ openBrowser: true });
            if (typeof deviceStrat.saveToken === 'function' && authed2) {
              await deviceStrat.saveToken(authed2);
              console.log(`[OAuth] Token acquired (device_code) and saved: ${tokenFilePath}`);
            }
            lastRunAt.set(k, Date.now());
            return;
          } catch (e2) {
            const msg = e2 instanceof Error ? e2.message : String(e2 || '');
            console.error(`[OAuth] device_code fallback failed: ${msg}`);
            throw e2;
          }
        }
      } else {
        try {
          const authed = await strat.authenticate({ openBrowser });
          if (typeof strat.saveToken === 'function' && authed) {
            await strat.saveToken(authed);
            console.log(`[OAuth] Token acquired and saved: ${tokenFilePath}`);
          }
          lastRunAt.set(k, Date.now());
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e || '');
          console.error(`[OAuth] interactive flow failed: ${msg}`);
          throw e;
        }
      }
    } catch (err) {
      // 避免二次无条件触发授权：直接上抛，让调用方决定
      throw err;
    }
  })();

  inFlight.set(k, p);
  try { await p; } finally { inFlight.delete(k); }
}

export async function handleUpstreamInvalidOAuthToken(
  providerType: string,
  auth: OAuthAuth,
  upstreamError: unknown
): Promise<boolean> {
  try {
    const msg = upstreamError instanceof Error ? upstreamError.message : String(upstreamError || '');
    // quick heuristics for token invalid
    const looksInvalid = /401|403|invalid[_-]?token|expired|40308/i.test(msg);
    if (!looksInvalid) return false;
    await ensureValidOAuthToken(providerType, auth, { forceReacquireIfRefreshFails: true });
    return true;
  } catch {
    return false;
  }
}

// 读取 ~/.routecodex/auth/iflow-oauth.log 的最后一条记录，提取 decoded 字段中的 client_id:client_secret
async function inferIflowClientCredsFromLog(): Promise<{ clientId?: string; clientSecret?: string } | null> {
  try {
    const home = process.env.HOME || '';
    const file = path.join(home, '.routecodex', 'auth', 'iflow-oauth.log');
    const txt = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!txt) return null;
    // 取最后一个非空行
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;
    // 从末尾向前找包含 decoded 的 JSON 行
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      try {
        const obj = JSON.parse(line);
        const decoded = String(obj.decoded || '');
        if (decoded.includes(':')) {
          const idx = decoded.indexOf(':');
          const id = decoded.slice(0, idx).trim();
          const secret = decoded.slice(idx + 1).trim();
          if (id && secret) {
            return { clientId: id, clientSecret: secret };
          }
        }
      } catch { /* skip parse errors */ }
    }
    return null;
  } catch {
    return null;
  }
}
