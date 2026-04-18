import type { Request, Response } from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { resolveRccProviderDir } from '../../config/user-data-paths.js';
import { getBootstrapProviderTemplates, isManagedBootstrapTemplate } from '../../cli/config/bootstrap-provider-templates.js';
import { collectV2ConfigSourceErrors, loadRouteCodexConfig } from '../../config/routecodex-config-loader.js';
import { ServerFactory } from '../../server-factory.js';
import type { ServerInstance } from '../../server-factory.js';

type JsonObject = Record<string, unknown>;
type ReloadableServerInstance = ServerInstance & {
  reloadRuntime?: (config: JsonObject, options: { providerProfiles?: unknown }) => Promise<void>;
};

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logConfigAdminNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[config-admin] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

/**
 * 与 index.ts 中逻辑对齐：解析用户配置文件路径。
 * 优先使用环境变量（RCC4_CONFIG_PATH / ROUTECODEX_CONFIG / ROUTECODEX_CONFIG_PATH），
 * 否则退回共享解析（~/.rcc/config.json 或默认配置）。
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
    } catch (error) {
      logConfigAdminNonBlockingError('pickUserConfigPath.checkCandidate', error, { path: p });
    }
  }
  return resolveRouteCodexConfigPath();
}

/**
 * Provider 模板与独立 Provider 配置所在目录。
 * 默认：~/.rcc/provider
 * 可通过 ROUTECODEX_PROVIDER_DIR 覆盖。
 */
function pickProviderDirectoryPath(): string {
  const envPath = process.env.ROUTECODEX_PROVIDER_DIR;
  if (envPath) {
    return envPath;
  }
  return resolveRccProviderDir();
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
 * - 独立 Provider（standalone）：来自 ~/.rcc/provider/*.json，
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
      configuredProviderIds = new Set<string>([
        ...resolveReferencedProviderIds(userConfig)
      ]);
    } catch (error) {
      logConfigAdminNonBlockingError('handleListProviderTemplates.readUserConfig', error);
    }

    // 2) 独立 Provider 配置：~/.rcc/provider/*.json
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
          if (!entry.isDirectory()) {
            continue;
          }
          const fullPath = path.join(providerDir, entry.name, 'config.v2.json');
          if (!fsSync.existsSync(fullPath)) {
            continue;
          }
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const parsed = JSON.parse(content);
            if (!isRecord(parsed)) {
              continue;
            }
            const providerNode = isRecord(parsed.provider) ? parsed.provider : parsed;
            const fallbackId = entry.name;
            const id = readString(parsed.providerId) ?? readString(providerNode.id) ?? fallbackId;
            const type = readString(providerNode.type) ?? readString(providerNode.providerType);
            const baseURL = readString(providerNode.baseURL) ?? readString(providerNode.baseUrl);
            const authType = isRecord(providerNode.auth) ? readString(providerNode.auth.type) : undefined;
            const boundToConfig = Boolean(id && configuredProviderIds.has(id));
            standalone.push({
              id,
              source: fullPath,
              type,
              baseURL,
              authType,
              boundToConfig
            });
          } catch (error) {
            logConfigAdminNonBlockingError('handleListProviderTemplates.readProviderConfig', error, {
              source: fullPath
            });
          }
        }
      }
    } catch (error) {
      logConfigAdminNonBlockingError('handleListProviderTemplates.readProviderDirectory', error, {
        providerDir
      });
    }

    // 3) 内置模板集合：标准 provider 只给协议级引导；OAuth/account provider 保留宿主管理模板
    const templates = getBootstrapProviderTemplates().map((template) => {
      const providerNode = isRecord(template.provider) ? template.provider : {};
      const authNode = isRecord(providerNode.auth) ? providerNode.auth : undefined;
      return {
        id: template.id,
        label: template.label,
        type: readString(providerNode.type) ?? 'openai',
        description: template.description,
        setupMode: isManagedBootstrapTemplate(template.id) ? 'managed-auth' : 'guided',
        defaults: {
          ...(readString(providerNode.type) ? { type: readString(providerNode.type) } : {}),
          ...(readString(providerNode.compatibilityProfile) ? { compatibilityProfile: readString(providerNode.compatibilityProfile) } : {}),
          ...(authNode ? { auth: authNode } : {})
        }
      };
    });

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
  errors.push(...collectV2ConfigSourceErrors(config));
  if (errors.length) {
    return errors;
  }
  const referencedProviderIds = resolveReferencedProviderIds(config);
  if (!referencedProviderIds.length) {
    errors.push('v2 config active routing must reference at least one provider target');
  }
  return errors;
}

function resolveReferencedProviderIds(config: JsonObject): string[] {
  const providerIds = new Set<string>();
  const pushTarget = (target: unknown) => {
    if (typeof target !== 'string' || !target.trim()) {
      return;
    }
    const providerId = target.trim().split('.', 1)[0];
    if (providerId) {
      providerIds.add(providerId);
    }
  };

  const collectFromRoutingNode = (routingNode: unknown) => {
    if (!isRecord(routingNode)) {
      return;
    }
    for (const entries of Object.values(routingNode)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        if (typeof entry === 'string') {
          pushTarget(entry);
          continue;
        }
        if (!isRecord(entry) || !Array.isArray(entry.targets)) {
          continue;
        }
        for (const target of entry.targets) {
          pushTarget(target);
        }
      }
    }
  };

  const virtualRouter = getVirtualRouter(config);
  collectFromRoutingNode(virtualRouter?.routing);
  const groups = isRecord(virtualRouter?.routingPolicyGroups) ? virtualRouter?.routingPolicyGroups : undefined;
  if (groups) {
    for (const group of Object.values(groups)) {
      if (isRecord(group)) {
        collectFromRoutingNode(group.routing);
      }
    }
  }
  collectFromRoutingNode((config as { routing?: unknown }).routing);
  return [...providerIds];
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
