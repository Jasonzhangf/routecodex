/**
 * iFlow UserInfo 获取API Key的辅助函数
 * 对齐CLIProxyAPI的实现
 */

export interface IFlowUserInfo {
  apiKey: string;
  email: string;
  phone?: string;
}

export interface IFlowTokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  expires_at?: number;
  expired?: string;
  api_key?: string;
  email?: string;
  type?: string;
}

/**
 * 使用access_token调用iFlow的getUserInfo接口获取API Key
 * 等价于CLIProxyAPI的FetchUserInfo
 */
export async function fetchIFlowUserInfo(accessToken: string): Promise<IFlowUserInfo> {
  if (!accessToken?.trim()) {
    throw new Error('fetchIFlowUserInfo: access token is empty');
  }

  const endpoint = `https://iflow.cn/api/oauth/getUserInfo?accessToken=${encodeURIComponent(accessToken)}`;
  
  try {
    // 使用Node.js内置的fetch（Node 18+）
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'iflow-cli/2.0'
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`fetchIFlowUserInfo: HTTP ${response.status} ${response.statusText} - ${text}`);
    }

    const result = await response.json();
    
    // 解析响应格式：{ "success": true, "data": { "apiKey": "...", "email": "..." } }
    if (!result?.success || !result?.data) {
      throw new Error(`fetchIFlowUserInfo: invalid response format - ${JSON.stringify(result)}`);
    }

    const data = result.data;
    const apiKey = String(data.apiKey || '').trim();
    const email = String(data.email || data.phone || '').trim();

    if (!apiKey) {
      throw new Error('fetchIFlowUserInfo: empty api key returned');
    }
    if (!email) {
      throw new Error('fetchIFlowUserInfo: missing account email/phone in user info');
    }

    return { apiKey, email, phone: data.phone };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`fetchIFlowUserInfo: request failed - ${String(error)}`);
  }
}

/**
 * 将OAuth token与API Key合并，创建完整的iFlow token数据
 * 对齐CLIProxyAPI的IFlowTokenStorage格式
 */
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

export function mergeIFlowTokenData(
  oauthToken: UnknownObject,
  userInfo: IFlowUserInfo
): IFlowTokenData {
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

  return {
    ...oauthToken,
    api_key: userInfo.apiKey,
    email: userInfo.email,
    type: 'iflow',
    access_token: asString(oauthToken.access_token),
    token_type: asString(oauthToken.token_type, 'bearer'),
    refresh_token: asOptionalString(oauthToken.refresh_token),
    expires_in: asNumber(oauthToken.expires_in),
    scope: asOptionalString(oauthToken.scope),
    expires_at: asNumber(oauthToken.expires_at),
    expired: asOptionalString(oauthToken.expired)
  };
}
