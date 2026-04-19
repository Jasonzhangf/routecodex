import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import {
  buildQwenStainlessHeaderEntries,
  resolveQwenCodeUserAgent
} from '../core/utils/qwen-client-fingerprint.js';

/**
 * Qwen UserInfo 获取API Key的辅助函数
 * 对齐CLIProxyAPI的实现，为Qwen OAuth流程添加API Key获取功能
 */

export interface QwenUserInfo {
  apiKey?: string;
  email?: string;
  phone?: string;
  name?: string;
}

export interface QwenTokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  expires_at?: number;
  expired?: string;
  api_key?: string;
  apiKey?: string;
  email?: string;
  type?: string;
  norefresh?: boolean;
}

type ValidateQwenAccessTokenOptions = {
  accessToken: string;
  resourceUrl?: string;
  model?: string;
};

const QWEN_DEFAULT_RUNTIME_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

function resolveValidatedQwenRuntimeBaseUrl(resourceUrl?: string): string {
  const rawBase = typeof resourceUrl === 'string' ? resourceUrl.trim() : '';
  if (!rawBase) {
    return QWEN_DEFAULT_RUNTIME_BASE_URL;
  }
  let baseUrl = rawBase;
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.trim().toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const isOfficialQwenCodeHost = host === 'portal.qwen.ai' || host === 'chat.qwen.ai';
    const isDashscopeCompatibleHost = host === 'dashscope.aliyuncs.com' && /^\/compatible-mode(?:\/v1)?$/i.test(pathname);
    if (isOfficialQwenCodeHost && (!pathname || pathname === '/v1')) {
      return `${parsed.origin}/v1`;
    }
    if (isDashscopeCompatibleHost) {
      return `${parsed.origin}${pathname.endsWith('/v1') ? pathname : `${pathname}/v1`}`;
    }
  } catch {
    // Fall through to default runtime.
  }
  return QWEN_DEFAULT_RUNTIME_BASE_URL;
}

/**
 * 使用access_token调用Qwen的userInfo接口获取API Key
 * 等价于CLIProxyAPI的FetchUserInfo
 */
export async function fetchQwenUserInfo(accessToken: string): Promise<QwenUserInfo> {
  if (!accessToken?.trim()) {
    throw new Error('fetchQwenUserInfo: access token is empty');
  }

  const configured =
    String(process.env.ROUTECODEX_QWEN_USERINFO_URL || process.env.RCC_QWEN_USERINFO_URL || '').trim();
  // 经验值：chat.qwen.ai 的 user/info 路径可用；portal.qwen.ai 同路径在部分地区/时期会返回 404。
  const baseUrls = configured
    ? [configured]
    : [
        'https://chat.qwen.ai/api/v1/user/info',
        'https://portal.qwen.ai/api/v1/user/info'
      ];
  
  try {
    const userAgent = resolveQwenCodeUserAgent();
    const commonHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': userAgent,
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-UserAgent': userAgent,
      'X-DashScope-AuthType': 'qwen-oauth'
    };

    const candidates: Array<{ url: string; headers: Record<string, string> }> = [];
    for (const baseUrl of baseUrls) {
      // Prefer Authorization header (avoid leaking tokens in URLs).
      candidates.push({
        url: baseUrl,
        headers: { ...commonHeaders, Authorization: `Bearer ${accessToken.trim()}` }
      });
      // Backward-compat: some endpoints may accept token via query param.
      const sep = baseUrl.includes('?') ? '&' : '?';
      candidates.push({ url: `${baseUrl}${sep}accessToken=${encodeURIComponent(accessToken)}`, headers: commonHeaders });
      candidates.push({ url: `${baseUrl}${sep}access_token=${encodeURIComponent(accessToken)}`, headers: commonHeaders });
    }

    let lastStatus: number | null = null;
    let lastStatusText = '';
    let lastBody = '';
    for (const candidate of candidates) {
      const response = await fetch(candidate.url, { method: 'GET', headers: candidate.headers });
      if (!response.ok) {
        lastStatus = response.status;
        lastStatusText = response.statusText;
        lastBody = await response.text().catch(() => 'unknown error');
        continue;
      }
      const result = await response.json();

      // 解析响应格式，处理不同的可能格式
      if (!result) {
        throw new Error(`fetchQwenUserInfo: empty response`);
      }

      // Qwen的userInfo接口可能返回不同格式
      let data = result;
      if ((result as any).data) {
        data = (result as any).data;
      }
      if ((result as any).user) {
        data = (result as any).user;
      }

      const apiKey = String((data as any).apiKey || (data as any).api_key || '').trim();
      const email = String((data as any).email || (data as any).mail || '').trim();
      const phone = String((data as any).phone || (data as any).mobile || '').trim();
      const name = String((data as any).name || (data as any).displayName || '').trim();

      // Qwen可能不返回API Key，这种情况下我们仍然接受用户信息
      return {
        apiKey: apiKey || undefined,
        email: email || undefined,
        phone: phone || undefined,
        name: name || undefined
      };
    }

    throw new Error(`fetchQwenUserInfo: HTTP ${lastStatus ?? 0} ${lastStatusText} - ${lastBody}`);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`fetchQwenUserInfo: request failed - ${String(error)}`);
  }
}

/**
 * 用真实业务请求验证 Qwen access_token 是否可用于推理接口。
 * 只在严格校验（refresh / interactive acquire）时使用，避免把坏 token 写进 tokenFile 后再伪装成功。
 */
export async function validateQwenAccessToken(options: ValidateQwenAccessTokenOptions): Promise<void> {
  const accessToken = typeof options.accessToken === 'string' ? options.accessToken.trim() : '';
  if (!accessToken) {
    throw new Error('validateQwenAccessToken: access token is empty');
  }

  const model =
    typeof options.model === 'string' && options.model.trim()
      ? options.model.trim()
      : 'coder-model';
  const userAgent = resolveQwenCodeUserAgent();
  const baseUrl = resolveValidatedQwenRuntimeBaseUrl(options.resourceUrl);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': userAgent,
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-UserAgent': userAgent,
      'X-DashScope-AuthType': 'qwen-oauth',
      ...buildQwenStainlessHeaderEntries()
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '',
              cache_control: { type: 'ephemeral' }
            }
          ]
        },
        {
          role: 'user',
          content: 'Reply with exactly OK.'
        }
      ],
      stream: false,
      max_tokens: 1
    })
  });

  if (response.ok) {
    await response.text().catch(() => '');
    return;
  }

  const body = await response.text().catch(() => 'unknown error');
  throw new Error(`validateQwenAccessToken: HTTP ${response.status} ${response.statusText} - ${body}`);
}

/**
 * 将OAuth token与用户信息合并，创建完整的Qwen token数据
 */
export function mergeQwenTokenData(
  oauthToken: UnknownObject,
  userInfo: QwenUserInfo
): QwenTokenData {
  const asString = (value: unknown, fallback = ''): string => {
    return typeof value === 'string' && value.length ? value : fallback;
  };
  const asOptionalString = (value: unknown): string | undefined => {
    return typeof value === 'string' && value.length ? value : undefined;
  };
  const asNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };

  const accessToken = asString(oauthToken.access_token);
  const apiKeyRaw = typeof userInfo.apiKey === 'string' ? userInfo.apiKey.trim() : '';
  const hasStableApiKey = Boolean(apiKeyRaw) && apiKeyRaw !== accessToken;

  const merged: QwenTokenData = {
    ...oauthToken,
    // Keep API keys consistent across readers.
    ...(apiKeyRaw ? { api_key: apiKeyRaw } : {}),
    ...(apiKeyRaw ? { apiKey: apiKeyRaw } : {}),
    ...(hasStableApiKey ? { norefresh: true } : {}),
    ...(userInfo.email ? { email: userInfo.email } : {}),
    type: 'qwen',
    access_token: accessToken,
    token_type: asString(oauthToken.token_type, 'bearer'),
    refresh_token: asOptionalString(oauthToken.refresh_token),
    expires_in: asNumber(oauthToken.expires_in),
    scope: asOptionalString(oauthToken.scope),
    expires_at: asNumber(oauthToken.expires_at),
    expired: asOptionalString(oauthToken.expired)
  };

  return merged;
}

/**
 * 检查Qwen token是否包含API Key
 */
export function hasQwenApiKey(token: UnknownObject): boolean {
  const candidate = token.api_key ?? token.apiKey;
  return typeof candidate === 'string' && candidate.trim().length > 0;
}
