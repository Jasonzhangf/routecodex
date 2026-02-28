/**
 * Gemini CLI UserInfo 辅助函数
 * 对齐 CLIProxyAPI 的实现，为 Gemini CLI OAuth 流程添加 UserInfo 和 Projects 获取功能
 */

import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { formatOAuthErrorMessage } from './oauth-error-message.js';

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

const USERINFO_RETRY_ATTEMPTS = 3;
const USERINFO_RETRY_BASE_DELAY_MS = 500;
const USERINFO_FETCH_TIMEOUT_MS = 15000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('fetch failed') ||
    lower.includes('aborted') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnreset') ||
    lower.includes('ecconnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('ehostunreach')
  );
}

async function requestGoogleJson(
  endpoint: string,
  accessToken: string,
  label: 'fetchGeminiCLIUserInfo' | 'fetchGeminiCLIProjects'
): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < USERINFO_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), USERINFO_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        if (attempt < USERINFO_RETRY_ATTEMPTS - 1 && isRetryableHttpStatus(response.status)) {
          await delay(USERINFO_RETRY_BASE_DELAY_MS * (attempt + 1));
          continue;
        }
        throw new Error(`${label}: HTTP ${response.status} ${response.statusText} - ${text}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      const msg = formatOAuthErrorMessage(error);
      const retriable = attempt < USERINFO_RETRY_ATTEMPTS - 1 && isRetryableNetworkError(msg);
      if (retriable) {
        await delay(USERINFO_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }

      if (error instanceof Error && error.message.startsWith(`${label}:`)) {
        throw error;
      }
      lastError = new Error(`${label}: request failed - ${msg}`);
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`${label}: request failed - unknown error`);
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

  const result = await requestGoogleJson(endpoint, accessToken.trim(), 'fetchGeminiCLIUserInfo');

  if (!result || typeof result !== 'object') {
    throw new Error('fetchGeminiCLIUserInfo: empty response');
  }

  const user = result as Record<string, unknown>;
  return {
    email: typeof user.email === 'string' ? user.email : undefined,
    name: typeof user.name === 'string' ? user.name : undefined,
    picture: typeof user.picture === 'string' ? user.picture : undefined,
    verified_email: typeof user.verified_email === 'boolean' ? user.verified_email : undefined
  };
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

  const result = await requestGoogleJson(endpoint, accessToken.trim(), 'fetchGeminiCLIProjects');

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

  return projectsField
    .map((project: UnknownObject) => ({
      projectId: String(project.projectId || ''),
      name: typeof project.name === 'string' ? project.name : undefined
    }))
    .filter((p: GeminiCLIProject) => p.projectId);
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
  if (Array.isArray(token.projects) && token.projects.length > 0) {
    const projects = token.projects as UnknownObject[];
    const tierScore = (value: unknown): number => {
      if (typeof value !== 'string') {
        return 0;
      }
      const upper = value.trim().toUpperCase();
      if (upper === 'ULTRA' || upper === 'ENTERPRISE') {
        return 3;
      }
      if (upper === 'PRO' || upper === 'PAID') {
        return 2;
      }
      if (upper === 'FREE') {
        return 1;
      }
      return 0;
    };
    const boolScore = (value: unknown): number => (value === true ? 2 : 0);
    const numberScore = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const getStringField = (project: UnknownObject, keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = project[key];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return undefined;
    };
    let bestProjectId: string | undefined;
    let bestScore = 0;
    for (const project of projects) {
      if (!project || typeof project !== 'object') {
        continue;
      }
      const projectId = getStringField(project, ['projectId', 'project_id', 'id']);
      if (!projectId) {
        continue;
      }
      const score =
        tierScore(getStringField(project, ['subscription_tier', 'subscriptionTier', 'tier', 'paid_tier', 'paidTier'])) +
        boolScore(project.licensed) +
        boolScore(project.hasLicense) +
        boolScore(project.has_code_assist) +
        boolScore(project.hasCodeAssist) +
        boolScore(project.codeAssistEligible) +
        numberScore(project.priority) +
        numberScore(project.weight);
      if (score > bestScore) {
        bestScore = score;
        bestProjectId = projectId;
      }
    }
    if (bestProjectId && bestScore > 0) {
      return bestProjectId;
    }
    if (typeof token.project_id === 'string' && token.project_id) {
      return token.project_id;
    }
    if (typeof token.projectId === 'string' && token.projectId) {
      return token.projectId;
    }
    const firstProject = projects[0];
    return typeof firstProject.projectId === 'string'
      ? String(firstProject.projectId)
      : undefined;
  }
  if (typeof token.project_id === 'string' && token.project_id) {
    return token.project_id;
  }
  if (typeof token.projectId === 'string' && token.projectId) {
    return token.projectId;
  }
  return undefined;
}

/**
 * 检查是否包含有效的 projects
 */
export function hasValidProjects(token: UnknownObject): boolean {
  return Array.isArray(token.projects) && token.projects.length > 0;
}
