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
  email?: string;
  type?: string;
}

/**
 * 使用access_token调用Qwen的userInfo接口获取API Key
 * 等价于CLIProxyAPI的FetchUserInfo
 */
export async function fetchQwenUserInfo(accessToken: string): Promise<QwenUserInfo> {
  if (!accessToken?.trim()) {
    throw new Error('fetchQwenUserInfo: access token is empty');
  }

  const endpoint = `https://portal.qwen.ai/api/v1/user/info?access_token=${encodeURIComponent(accessToken)}`;
  
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': 'gl-node/22.17.0',
        'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`fetchQwenUserInfo: HTTP ${response.status} ${response.statusText} - ${text}`);
    }

    const result = await response.json();
    
    // 解析响应格式，处理不同的可能格式
    if (!result) {
      throw new Error(`fetchQwenUserInfo: empty response`);
    }

    // Qwen的userInfo接口可能返回不同格式
    let data = result;
    if (result.data) {
      data = result.data;
    }
    if (result.user) {
      data = result.user;
    }

    const apiKey = String(data.apiKey || data.api_key || '').trim();
    const email = String(data.email || data.mail || '').trim();
    const phone = String(data.phone || data.mobile || '').trim();
    const name = String(data.name || data.displayName || '').trim();

    // Qwen可能不返回API Key，这种情况下我们仍然接受用户信息
    return { 
      apiKey: apiKey || undefined, 
      email: email || undefined, 
      phone: phone || undefined,
      name: name || undefined
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`fetchQwenUserInfo: request failed - ${String(error)}`);
  }
}

/**
 * 将OAuth token与用户信息合并，创建完整的Qwen token数据
 */
export function mergeQwenTokenData(
  oauthToken: Record<string, any>,
  userInfo: QwenUserInfo
): QwenTokenData {
  return {
    ...oauthToken,
    api_key: userInfo.apiKey,
    email: userInfo.email,
    type: 'qwen',
    // 确保基本字段存在
    access_token: oauthToken.access_token || '',
    token_type: oauthToken.token_type || 'bearer',
    refresh_token: oauthToken.refresh_token,
    expires_in: oauthToken.expires_in,
    scope: oauthToken.scope,
    expires_at: oauthToken.expires_at,
    expired: oauthToken.expired
  };
}

/**
 * 检查Qwen token是否包含API Key
 */
export function hasQwenApiKey(token: Record<string, any>): boolean {
  const apiKey = (token as any).api_key || (token as any).apiKey || '';
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}
