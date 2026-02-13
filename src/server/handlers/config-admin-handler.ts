import type { Request, Response } from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { loadRouteCodexConfig } from '../../config/routecodex-config-loader.js';
import { ServerFactory } from '../../server-factory.js';
import type { ServerInstance } from '../../server-factory.js';

type JsonObject = Record<string, unknown>;
type ReloadableServerInstance = ServerInstance & {
  reloadRuntime?: (config: JsonObject, options: { providerProfiles?: unknown }) => Promise<void>;
};

/**
 * 与 index.ts 中逻辑对齐：解析用户配置文件路径。
 * 优先使用环境变量（RCC4_CONFIG_PATH / ROUTECODEX_CONFIG / ROUTECODEX_CONFIG_PATH），
 * 否则退回共享解析（~/.routecodex/config.json 或默认配置）。
 */
function pickUserConfigPath(): string {
  const envPaths = [
    process.env.RCC4_CONFIG_PATH,
    process.env.ROUTECODEX_CONFIG,
    process.env.ROUTECODEX_CONFIG_PATH
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const p of envPaths) {
    try {
      if (p && fsSync.existsSync(p) && fsSync.statSync(p).isFile()) {
        return p;
      }
    } catch {
      // ignore and continue
    }
  }
  return resolveRouteCodexConfigPath();
}

/**
 * Provider 模板与独立 Provider 配置所在目录。
 * 默认：~/.routecodex/provider
 * 可通过 ROUTECODEX_PROVIDER_DIR 覆盖。
 */
function pickProviderDirectoryPath(): string {
  const envPath = process.env.ROUTECODEX_PROVIDER_DIR;
  if (envPath) {
    return envPath;
  }
  return path.join(homedir(), '.routecodex', 'provider');
}

export async function handleGetUserConfig(req: Request, res: Response): Promise<void> {
  try {
    const userConfigPath = pickUserConfigPath();
    const content = await fs.readFile(userConfigPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
      res.status(500).json({
        error: {
          message: 'Configuration file root must be an object',
          type: 'config_read_error'
        }
      });
      return;
    }
    res.json({ path: userConfigPath, config: parsed });
  } catch (error: unknown) {
    res.status(500).json({
      error: {
        message: formatErrorMessage(error),
        type: 'config_read_error'
      }
    });
  }
}

/**
 * 列出 Provider 模板与独立 Provider 配置。
 *
 * - 模板（templates）：目前提供少量内置模板，用于快速创建 provider 配置。
 * - 独立 Provider（standalone）：来自 ~/.routecodex/provider/*.json，
 *   并标记是否已在当前 user config 中被引用（boundToConfig）。
 */
export async function handleListProviderTemplates(req: Request, res: Response): Promise<void> {
  try {
    // 1) 当前 user config，用于判断哪些 provider 已绑定
    let configuredProviderIds = new Set<string>();
    try {
      const userConfigPath = pickUserConfigPath();
      const content = await fs.readFile(userConfigPath, 'utf-8');
      const parsed = JSON.parse(content);
      const userConfig: JsonObject = isRecord(parsed) ? parsed : {};
      const providersRoot = resolveProviders(userConfig);
      configuredProviderIds = new Set<string>(Object.keys(providersRoot || {}));
    } catch {
      // 若读取失败，不阻止模板列表返回；仅视为无绑定信息
    }

    // 2) 独立 Provider 配置：~/.routecodex/provider/*.json
    const providerDir = pickProviderDirectoryPath();
    const standalone: Array<{
      id: string;
      source: string;
      type?: string;
      baseURL?: string;
      authType?: string;
      boundToConfig: boolean;
    }> = [];

    try {
      if (fsSync.existsSync(providerDir) && fsSync.statSync(providerDir).isDirectory()) {
        const entries = await fs.readdir(providerDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) {
            continue;
          }
          if (!entry.name.endsWith('.json')) {
            continue;
          }
          const fullPath = path.join(providerDir, entry.name);
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const parsed = JSON.parse(content);
            if (!isRecord(parsed)) {
              continue;
            }
            const fallbackId = path.basename(entry.name, '.json');
            const id = readString(parsed.id) ?? readString(parsed.providerId) ?? fallbackId;
            const type = readString(parsed.type) ?? readString(parsed.providerType);
            const baseURL = readString(parsed.baseURL) ?? readString(parsed.baseUrl);
            const authType = isRecord(parsed.auth) ? readString(parsed.auth.type) : undefined;
            const boundToConfig = Boolean(id && configuredProviderIds.has(id));
            standalone.push({
              id,
              source: fullPath,
              type,
              baseURL,
              authType,
              boundToConfig
            });
          } catch {
            // 单个文件解析失败时跳过，不影响整体返回
          }
        }
      }
    } catch {
      // provider 目录不存在或不可读时，视为无独立 Provider
    }

    // 3) 内置模板集合：仅提供最少字段，具体校验交由客户端完成
    const templates = [
      {
        id: 'openai-standard',
        label: 'OpenAI 标准模板',
        type: 'openai',
        description: 'OpenAI Chat 兼容 provider 模板（auth.type=apikey）',
        defaults: {
          type: 'openai',
          auth: { type: 'apikey' }
        }
      },
      {
        id: 'qwen-oauth',
        label: 'Qwen OAuth 模板',
        type: 'openai',
        description: 'Qwen OAuth provider 模板（auth.type=oauth）',
        defaults: {
          type: 'openai',
          auth: { type: 'oauth' }
        }
      },
      {
        id: 'iflow-oauth',
        label: 'iFlow OAuth 模板',
        type: 'iflow',
        description: 'iFlow OAuth provider 模板（auth.type=iflow-oauth）',
        defaults: {
          type: 'iflow',
          auth: { type: 'iflow-oauth' }
        }
      },
      {
        id: 'deepseek-web-account',
        label: 'DeepSeek Web 账号模板',
        type: 'openai',
        description: 'DeepSeek Web provider 模板（auth.type=deepseek-account，compatibilityProfile=chat:deepseek-web）',
        defaults: {
          type: 'openai',
          compatibilityProfile: 'chat:deepseek-web',
          auth: {
            type: 'deepseek-account',
            entries: [
              {
                alias: '1',
                type: 'deepseek-account',
                tokenFile: '~/.routecodex/auth/deepseek-account-1.json'
              }
            ]
          },
          deepseek: {
            strictToolRequired: true,
            textToolFallback: true,
            powTimeoutMs: 15000,
            powMaxAttempts: 2,
            sessionReuseTtlMs: 1800000
          }
        }
      }
    ];

    res.json({
      templates,
      standalone
    });
  } catch (error: unknown) {
    res.status(500).json({
      error: {
        message: formatErrorMessage(error),
        type: 'provider_templates_error'
      }
    });
  }
}

export async function handleValidateUserConfig(req: Request, res: Response): Promise<void> {
  try {
    const draftConfig: JsonObject = isRecord(req.body) ? req.body : {};
    const errors = validateUserConfig(draftConfig);
    if (errors.length) {
      res.status(400).json({ ok: false, errors });
    } else {
      res.json({ ok: true });
    }
  } catch (error: unknown) {
    res.status(500).json({
      ok: false,
      errors: [formatErrorMessage(error)]
    });
  }
}

export async function handleSaveUserConfig(req: Request, res: Response): Promise<void> {
  try {
    const userConfigPath = pickUserConfigPath();
    const draftConfig: JsonObject = isRecord(req.body) ? req.body : {};
    const errors = validateUserConfig(draftConfig);
    if (errors.length) {
      res.status(400).json({ ok: false, errors });
      return;
    }

    await fs.writeFile(userConfigPath, JSON.stringify(draftConfig, null, 2), 'utf-8');

    // 写入成功后，基于最新配置重新生成虚拟路由配置并热重载流水线
    try {
      const v2 = ServerFactory.getV2Instance() as ReloadableServerInstance | undefined;
      if (!v2 || typeof v2.reloadRuntime !== 'function') {
        throw new Error('RouteCodex V2 server does not expose runtime reload');
      }
      const { userConfig: latestConfig, providerProfiles } = await loadRouteCodexConfig(userConfigPath);
      await v2.reloadRuntime(latestConfig, { providerProfiles });
    } catch (reloadError: unknown) {
      // 配置文件已写入，但运行时重载失败，向调用方明确返回错误信息
      res.status(500).json({
        ok: false,
        errors: [
          'Config saved but runtime reload failed',
          formatErrorMessage(reloadError)
        ]
      });
      return;
    }

    res.json({ ok: true, path: userConfigPath });
  } catch (error: unknown) {
    res.status(500).json({
      ok: false,
      errors: [formatErrorMessage(error)]
    });
  }
}

function validateUserConfig(config: JsonObject): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') {
    errors.push('Configuration must be an object');
    return errors;
  }
  const providers = resolveProviders(config);
  const routing = resolveRouting(config);
  if (!Object.keys(providers).length) {
    errors.push('virtualrouter.providers (or providers) must include at least one provider entry');
  }
  if (!Object.keys(routing).length) {
    errors.push('virtualrouter.routing (or routing) must define at least one route');
  }
  for (const [routeName, entries] of Object.entries(routing)) {
    if (!Array.isArray(entries) || !entries.length) {
      errors.push(`Route "${routeName}" must list at least one provider key`);
      continue;
    }
    for (const key of entries) {
      if (typeof key !== 'string' || !key.trim()) {
        errors.push(`Route "${routeName}" contains invalid provider key`);
        continue;
      }
      const providerId = key.split('.')[0];
      if (!providers[providerId]) {
        errors.push(`Route "${routeName}" references unknown provider "${providerId}"`);
      }
    }
  }
  return errors;
}

function resolveProviders(config: JsonObject): Record<string, unknown> {
  const virtualRouter = getVirtualRouter(config);
  if (virtualRouter?.providers && isRecord(virtualRouter.providers)) {
    return virtualRouter.providers;
  }
  if (isRecord((config as { providers?: unknown }).providers)) {
    return (config as { providers: Record<string, unknown> }).providers;
  }
  return {};
}

function resolveRouting(config: JsonObject): Record<string, string[]> {
  const virtualRouter = getVirtualRouter(config);
  const routingNode = virtualRouter?.routing ?? (config as { routing?: unknown }).routing;
  if (routingNode && isRecord(routingNode)) {
    const normalized: Record<string, string[]> = {};
    for (const [route, list] of Object.entries(routingNode)) {
      normalized[route] = Array.isArray(list)
        ? list.map((item) => String(item).trim()).filter(Boolean)
        : [];
    }
    return normalized;
  }
  return {};
}

type VirtualRouterLike = JsonObject & {
  providers?: Record<string, unknown>;
  routing?: Record<string, unknown>;
};

function getVirtualRouter(config: JsonObject): VirtualRouterLike | undefined {
  const candidate = (config as { virtualrouter?: unknown }).virtualrouter;
  return isVirtualRouterLike(candidate) ? candidate : undefined;
}

function isVirtualRouterLike(value: unknown): value is VirtualRouterLike {
  return isRecord(value);
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
