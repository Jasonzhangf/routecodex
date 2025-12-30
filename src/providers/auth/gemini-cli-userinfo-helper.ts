/**
 * Gemini CLI UserInfo 辅助函数
 * 对齐 CLIProxyAPI 的实现，为 Gemini CLI OAuth 流程添加 UserInfo 和 Projects 获取功能
 */

import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

export interface GeminiCLIUserInfo {
  email?: string;
  name?: string;
  picture?: string;
  verified_email?: boolean;
}

export interface GeminiCLIProject {
  projectId: string;
  name?: string;
}

export interface GeminiCLITokenData extends UnknownObject {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  expires_at?: number;
  expired?: string;
  email?: string;
  name?: string;
  picture?: string;
  projects?: GeminiCLIProject[];
  project_id?: string;
  shared_credential?: boolean;
}

/**
 * 使用 access_token 调用 Google UserInfo 接口
 * 等价于 CLIProxyAPI 的 fetchUserInfo
 */
export async function fetchGeminiCLIUserInfo(accessToken: string): Promise<GeminiCLIUserInfo> {
  if (!accessToken?.trim()) {
    throw new Error('fetchGeminiCLIUserInfo: access token is empty');
  }

  const endpoint = 'https://www.googleapis.com/oauth2/v2/userinfo';

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`fetchGeminiCLIUserInfo: HTTP ${response.status} ${response.statusText} - ${text}`);
    }

    const result = await response.json();

    if (!result) {
      throw new Error('fetchGeminiCLIUserInfo: empty response');
    }

    return {
      email: typeof result.email === 'string' ? result.email : undefined,
      name: typeof result.name === 'string' ? result.name : undefined,
      picture: typeof result.picture === 'string' ? result.picture : undefined,
      verified_email: typeof result.verified_email === 'boolean' ? result.verified_email : undefined
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`fetchGeminiCLIUserInfo: request failed - ${String(error)}`);
  }
}

/**
 * 使用 access_token 获取 Google Projects 列表
 * 等价于 CLIProxyAPI 的 listProjects
 */
export async function fetchGeminiCLIProjects(accessToken: string): Promise<GeminiCLIProject[]> {
  if (!accessToken?.trim()) {
    throw new Error('fetchGeminiCLIProjects: access token is empty');
  }

  const endpoint = 'https://cloudresourcemanager.googleapis.com/v1/projects';

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`fetchGeminiCLIProjects: HTTP ${response.status} ${response.statusText} - ${text}`);
    }

    const result = await response.json();

    if (!result || typeof result !== 'object') {
      // Treat non-object / empty responses as "no projects" rather than a hard error.
      return [];
    }

    const projectsField = (result as { projects?: UnknownObject }).projects;

    if (!projectsField) {
      // Some accounts legitimately return `{}` with HTTP 200 when there are no visible projects.
      // In that case, we proceed with an empty list instead of failing OAuth.
      return [];
    }

    if (!Array.isArray(projectsField)) {
      throw new Error('fetchGeminiCLIProjects: invalid response format');
    }

    return projectsField.map((project: UnknownObject) => ({
      projectId: String(project.projectId || ''),
      name: typeof project.name === 'string' ? project.name : undefined
    })).filter((p: GeminiCLIProject) => p.projectId);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`fetchGeminiCLIProjects: request failed - ${String(error)}`);
  }
}

/**
 * 将 OAuth token 与 UserInfo 和 Projects 合并
 * 等价于 CLIProxyAPI 的 mergeTokenData
 */
export function mergeGeminiCLITokenData(
  oauthToken: UnknownObject,
  userInfo: GeminiCLIUserInfo,
  projects: GeminiCLIProject[]
): GeminiCLITokenData {
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

  // 计算 expires_at
  let expiresAt: number | undefined;
  if (oauthToken.expires_at) {
    expiresAt = asNumber(oauthToken.expires_at);
  } else if (oauthToken.expires_in) {
    const expiresIn = asNumber(oauthToken.expires_in);
    if (expiresIn) {
      expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    }
  }

  return {
    ...oauthToken,
    access_token: asString(oauthToken.access_token),
    token_type: asString(oauthToken.token_type, 'Bearer'),
    refresh_token: asOptionalString(oauthToken.refresh_token),
    expires_in: asNumber(oauthToken.expires_in),
    scope: asOptionalString(oauthToken.scope),
    expires_at: expiresAt,
    expired: asOptionalString(oauthToken.expired),
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    projects: projects,
    project_id: projects.length > 0 ? projects[0].projectId : undefined,
    shared_credential: true
  };
}

/**
 * 获取默认 project_id
 */
export function getDefaultProjectId(token: UnknownObject): string | undefined {
  if (typeof token.project_id === 'string' && token.project_id) {
    return token.project_id;
  }
  if (typeof token.projectId === 'string' && token.projectId) {
    return token.projectId;
  }
  if (Array.isArray(token.projects) && token.projects.length > 0) {
    const firstProject = token.projects[0] as UnknownObject;
    return typeof firstProject.projectId === 'string' ? firstProject.projectId : undefined;
  }
  return undefined;
}

/**
 * 检查是否包含有效的 projects
 */
export function hasValidProjects(token: UnknownObject): boolean {
  return Array.isArray(token.projects) && token.projects.length > 0;
}
