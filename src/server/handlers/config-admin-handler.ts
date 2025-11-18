import type { Request, Response } from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { ConfigManagerModule } from '../../modules/config-manager/config-manager-module.js';
import { ServerFactory } from '../../server-factory.js';

type LoadResult<T = unknown> = { ok: true; data: T } | { ok: false; errors: string[] };

function isOk<T>(r: LoadResult<T>): r is { ok: true; data: T } {
  return !!r && (r as any).ok === true;
}

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
  ].filter(Boolean) as string[];

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
 * 与 index.ts 中 getDefaultModulesConfigPath 对齐：
 * 解析 system modules 配置路径（供 rcc-config-core 使用）。
 */
function pickSystemModulesPath(): string {
  const envPath = process.env.ROUTECODEX_MODULES_CONFIG;
  if (envPath) {
    try {
      if (fsSync.existsSync(envPath) && fsSync.statSync(envPath).isFile()) {
        return envPath;
      }
    } catch {
      // fall through to defaults
    }
  }

  const candidates = [
    './config/modules.json',
    path.join(process.cwd(), 'config', 'modules.json'),
    path.join(homedir(), '.routecodex', 'config', 'modules.json')
  ];

  for (const p of candidates) {
    try {
      if (fsSync.existsSync(p) && fsSync.statSync(p).isFile()) {
        return p;
      }
    } catch {
      // ignore
    }
  }
  // 回退到项目内默认路径
  return './config/modules.json';
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
    const json = JSON.parse(content);
    res.json({ path: userConfigPath, config: json });
  } catch (error: any) {
    res.status(500).json({
      error: {
        message: error?.message || String(error),
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
      const json = JSON.parse(content);
      const vr = json?.virtualrouter ?? {};
      const providersRoot = vr.providers ?? json?.providers ?? {};
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
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith('.json')) continue;
          const fullPath = path.join(providerDir, entry.name);
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const json = JSON.parse(content);
            const id =
              json?.id ||
              json?.providerId ||
              path.basename(entry.name, '.json');
            const type = json?.type || json?.providerType;
            const baseURL = json?.baseURL || json?.baseUrl;
            const authType = json?.auth?.type;
            const boundToConfig = configuredProviderIds.has(id);
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

    // 3) 内置模板集合：仅提供最少字段，具体校验交由 config-core
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
        description: 'Qwen OAuth provider 模板（auth.type=oauth，具体 OAuth 行为由 config-core/host 决定）',
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
      }
    ];

    res.json({
      templates,
      standalone
    });
  } catch (error: any) {
    res.status(500).json({
      error: {
        message: error?.message || String(error),
        type: 'provider_templates_error'
      }
    });
  }
}

export async function handleValidateUserConfig(req: Request, res: Response): Promise<void> {
  try {
    const systemPath = pickSystemModulesPath();
    const draftConfig = (req.body && typeof req.body === 'object') ? req.body : {};

    const core = await import('rcc-config-core');
    const sys: LoadResult = await core.loadSystemConfig(systemPath);
    const usrDraft: LoadResult = { ok: true, data: draftConfig };

    const canonical = core.buildCanonical(
      isOk(sys) ? sys : { ok: true, data: {} },
      usrDraft,
      { keyDimension: 'perKey' } as any
    );

    // 尝试导出装配配置：若抛错则视为配置结构不合法
    try {
      core.exportAssemblerConfigV2(canonical);
    } catch (e: any) {
      const msg = e?.message || String(e ?? 'Unknown assembler error');
      res.status(400).json({ ok: false, errors: [msg] });
      return;
    }

    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      errors: [error?.message || String(error)]
    });
  }
}

export async function handleSaveUserConfig(req: Request, res: Response): Promise<void> {
  try {
    const userConfigPath = pickUserConfigPath();
    const draftConfig = (req.body && typeof req.body === 'object') ? req.body : {};

    // 写入前进行一次完整校验，避免生成不可用配置
    const systemPath = pickSystemModulesPath();
    const core = await import('rcc-config-core');
    const sys: LoadResult = await core.loadSystemConfig(systemPath);
    const usrDraft: LoadResult = { ok: true, data: draftConfig };
    const canonical = core.buildCanonical(
      isOk(sys) ? sys : { ok: true, data: {} },
      usrDraft,
      { keyDimension: 'perKey' } as any
    );
    try {
      core.exportAssemblerConfigV2(canonical);
    } catch (e: any) {
      const msg = e?.message || String(e ?? 'Unknown assembler error');
      res.status(400).json({ ok: false, errors: [msg] });
      return;
    }

    // 校验通过后，写入用户配置文件（pretty JSON）
    await core.writeJsonPretty(userConfigPath, draftConfig);

    // 写入成功后，基于最新配置重新生成 merged-config 并热重载流水线
    try {
      const systemPath = pickSystemModulesPath();

      // 1) 使用 ConfigManagerModule 重新生成 merged-config.<port>.json
      const v2 = ServerFactory.getV2Instance() as any;
      let port: number | null = null;
      try {
        const cfg = typeof v2?.getServerConfig === 'function' ? v2.getServerConfig() : null;
        if (cfg && typeof cfg.port === 'number') {
          port = cfg.port;
        }
      } catch {
        port = null;
      }

      // 若无法从运行中服务器获取端口，则回退到默认端口推断（dev 默认 5555）
      if (!port || !Number.isFinite(port)) {
        const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
        port = !Number.isNaN(envPort) && envPort > 0 ? envPort : 5555;
      }

      const mergedDir = path.dirname(userConfigPath);
      const mergedConfigPath = path.join(mergedDir, `merged-config.${port}.json`);

      const cfgMgr = new ConfigManagerModule(userConfigPath);
      await cfgMgr.initialize({
        configPath: userConfigPath,
        mergedConfigPath,
        systemModulesPath: systemPath
      });

      // 2) 读取最新 merged-config，并用 PipelineAssembler 重新组装流水线
      const mergedContent = await fs.readFile(mergedConfigPath, 'utf-8');
      const mergedConfig = JSON.parse(mergedContent);

      const pac = (mergedConfig as any)?.pipeline_assembler?.config;
      const hasAssemblerPipes = !!(pac && Array.isArray(pac.pipelines) && pac.pipelines.length > 0);
      if (!hasAssemblerPipes) {
        throw new Error(`No assembler pipelines found in ${mergedConfigPath}`);
      }

      const { PipelineAssembler } = await import('../../modules/pipeline/config/pipeline-assembler.js');
      const { manager, routePools, routeMeta } = await PipelineAssembler.assemble(mergedConfig);

      if (v2 && typeof v2.attachPipelineManager === 'function') {
        v2.attachPipelineManager(manager);
        v2.attachRoutePools(routePools);
        if (routeMeta) {
          v2.attachRouteMeta(routeMeta);
        }
        const classifierConfig = (mergedConfig as any)?.modules?.virtualrouter?.config?.classificationConfig;
        if (classifierConfig) {
          v2.attachRoutingClassifierConfig(classifierConfig);
        }
      }
    } catch (reloadError: any) {
      // 配置文件已写入，但流水线重载失败，向调用方明确返回错误信息
      res.status(500).json({
        ok: false,
        errors: [
          'Config saved but pipeline reload failed',
          reloadError?.message || String(reloadError)
        ]
      });
      return;
    }

    res.json({ ok: true, path: userConfigPath });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      errors: [error?.message || String(error)]
    });
  }
}
