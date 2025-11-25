/**
 * Config Manager Module (config-core only)
 * 仅依赖 rcc-config-core 生成 merged-config 与 V2 装配输入
 */

import { BaseModule } from './base-module-shim.js';
import type { UnknownObject } from '../../types/common-types.js';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';
import path from 'path';
import { homedir } from 'os';

type CanonicalConfig = {
  providers?: Record<string, unknown>;
  keyVault?: Record<string, unknown>;
  routing?: Record<string, unknown>;
  routeMeta?: Record<string, unknown>;
  _metadata?: Record<string, unknown>;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function buildCompatibilityKeyMappingsLocal(canonical: CanonicalConfig): { providers: Record<string, Record<string, string>> } {
  const out: { providers: Record<string, Record<string, string>> } = { providers: {} };
  try {
    const vault = asRecord(canonical.keyVault || {});
    for (const [provId, keys] of Object.entries(vault)) {
      const m: Record<string, string> = {};
      for (const [keyId, meta] of Object.entries(asRecord(keys))) {
        const v = asRecord(meta).value;
        if (typeof v === 'string' && v.trim()) m[keyId] = v.trim();
      }
      if (Object.keys(m).length) out.providers[provId] = m;
    }
  } catch {
    // non-fatal
  }
  return out;
}

export class ConfigManagerModule extends BaseModule {
  private configPath: string;
  private systemConfigPath: string;
  private mergedConfigPath: string;
  private authFileResolver: AuthFileResolver;
  private serverPort: number = 0;

  constructor(configPath?: string) {
    super({ id: 'config-manager', name: 'Configuration Manager', version: '2.0.0', description: 'Manages configuration (config-core only)' });
    this.configPath = configPath || path.join(homedir(), '.routecodex', 'config.json');
    this.systemConfigPath = './config/modules.json';
    this.mergedConfigPath = './config/merged-config.json';
    this.authFileResolver = new AuthFileResolver();
  }

  async initialize(config?: unknown): Promise<void> {
    const cfg = (config || {}) as Record<string, unknown>;
    if (typeof cfg['configPath'] === 'string') this.configPath = cfg['configPath'] as string;
    if (typeof cfg['mergedConfigPath'] === 'string') this.mergedConfigPath = cfg['mergedConfigPath'] as string;
    if (typeof cfg['systemModulesPath'] === 'string') this.systemConfigPath = cfg['systemModulesPath'] as string;
    if (typeof (cfg as any)['port'] === 'number') this.serverPort = (cfg as any)['port'] as number;

    await this.authFileResolver.ensureAuthDir();
    await this.generateMergedConfigViaCore();
  }

  async generateMergedConfig(): Promise<void> {
    await this.generateMergedConfigViaCore();
  }

  async reloadConfig(): Promise<void> {
    await this.generateMergedConfigViaCore();
  }

  private async generateMergedConfigViaCore(): Promise<void> {
    // 使用标准入口导入 rcc-config-core（包内已提供 dist/index.js 与 exports 字段）
    const core = await import('rcc-config-core');
    const sys = await core.loadSystemConfig(this.systemConfigPath);
    const usr = await core.loadUserConfig(this.configPath);
    if (!usr?.ok) {
      throw new Error(`User config invalid: ${usr?.errors?.join(', ') || 'unknown error'}`);
    }
    // 清理旧的 merged-config.*.json，确保每次启动都重新生成
    try {
      const pathMod = await import('path');
      const fs = await import('fs/promises');
      const dir = pathMod.dirname(this.mergedConfigPath);
      try {
        const files = await fs.readdir(dir);
        await Promise.all(
          files
            .filter(f => /^merged-config\.[0-9]+\.json$/.test(f) || f === 'merged-config.json')
            .map(f => fs.unlink(pathMod.join(dir, f)).catch(() => {}))
        );
      } catch { /* ignore */ }
    } catch { /* ignore cleanup errors */ }
    const canonical = core.buildCanonical(
      sys?.ok ? sys : { ok: true, data: {} },
      usr,
      { keyDimension: 'perKey' } as any
    ) as CanonicalConfig;

    // 由 config-core 导出装配配置（V2 装配输入）
    let assemblerConfig: any = core.exportAssemblerConfigV2(canonical);

    // 在本地重建 merged-config 结构，避免依赖未导出的 buildMergedConfig/writeMerged
    const keyMappings = buildCompatibilityKeyMappingsLocal(canonical);
    const mergedBase: Record<string, unknown> = {
      providers: canonical.providers,
      keyVault: canonical.keyVault,
      routing: canonical.routing,
      routeMeta: canonical.routeMeta,
      _metadata: canonical._metadata,
    };
    if (Object.keys(asRecord(keyMappings.providers)).length) {
      (mergedBase as any).compatibilityConfig = { keyMappings };
    }
    const built = { merged: mergedBase, assemblerConfig, keyMappings };
    // 安全去重：当同时配置了 auth.apiKey 与 apiKey[] 时，可能生成重复 keyAlias，导致重复流水线
    try {
      const cc = (built as any)?.merged?.compatibilityConfig || (built as any)?.compatibilityConfig || {};
      const keyMappings = (cc as any)?.keyMappings || {};
      const provMaps = (keyMappings as any)?.providers || {};
      // 针对每个 provider，按“实际密钥值”去重 keyId
      const dedup: Record<string, Record<string, string>> = {};
      for (const [provId, aliasMap] of Object.entries(provMaps as Record<string, any>)) {
        const seenValues = new Set<string>();
        const keep: Record<string, string> = {};
        for (const [alias, real] of Object.entries(aliasMap || {})) {
          const val = String(real || '').trim();
          if (!val) continue;
          if (seenValues.has(val)) continue;
          seenValues.add(val);
          keep[alias] = val;
        }
        dedup[provId] = keep;
      }
      // 过滤 assemblerConfig.pipelines 与 routePools 中重复 key 的流水线
      if (assemblerConfig && Array.isArray(assemblerConfig.pipelines)) {
        const keepIds = new Set<string>();
        const seenKeyPerProv: Record<string, Set<string>> = {};
        const filteredPipes = [] as any[];
        for (const p of assemblerConfig.pipelines) {
          const id = String(p.id || '');
          const authRef = (p as any).authRef || {};
          const provId = String(authRef.providerId || '').trim();
          const keyId = String(authRef.keyId || '').trim();
          if (!provId || !keyId) { filteredPipes.push(p); keepIds.add(id); continue; }
          const realMap = dedup[provId] || {};
          const real = String((realMap as any)[keyId] || '').trim();
          // 若该 alias 在去重后不存在，则视为重复来源，直接丢弃该流水线
          if (!real) { continue; }
          const bucket = (seenKeyPerProv[provId] = seenKeyPerProv[provId] || new Set<string>());
          if (bucket.has(real)) { continue; }
          bucket.add(real);
          filteredPipes.push(p);
          keepIds.add(id);
        }
        assemblerConfig.pipelines = filteredPipes;
        // 清理 routePools 中被剔除的 id
        const pools = (assemblerConfig as any).routePools || {};
        for (const k of Object.keys(pools || {})) {
          (pools as any)[k] = (Array.isArray((pools as any)[k]) ? (pools as any)[k] : []).filter((pid: string) => keepIds.has(pid));
        }
        assemblerConfig.routePools = pools;
      }
    } catch { /* non-fatal */ }

    // 补全 Provider V2 所需的 auth 配置（特别是 OAuth 场景，例如 qwen）
    // 注意：rcc-config-core 的 canonical 目前不会保留 providers[].auth，只保留 keyVault；
    // 这里从 user config 中提取 auth 并注入到 assemblerConfig.pipelines[].modules.provider.config.auth。
    try {
      const userData = (usr as any)?.data || {};
      const vrUser = (userData as any).virtualrouter || {};
      const userProviders = (vrUser as any).providers || (userData as any).providers || {};
      const providerAuthMap: Record<string, unknown> = {};
      for (const [provId, rawProv] of Object.entries(userProviders as Record<string, any>)) {
        const auth = (rawProv as any)?.auth;
        if (auth && typeof auth === 'object' && 'type' in auth) {
          providerAuthMap[provId] = auth;
        }
      }

      if (assemblerConfig && Array.isArray(assemblerConfig.pipelines) && Object.keys(providerAuthMap).length) {
        for (const p of assemblerConfig.pipelines as any[]) {
          const providerModule = (p as any)?.modules?.provider;
          const cfg = providerModule?.config || providerModule?.moduleConfig || null;
          if (!cfg) continue;
          if (cfg.auth && typeof cfg.auth === 'object' && 'type' in cfg.auth) continue;

          const provId: string =
            typeof cfg.providerId === 'string' && cfg.providerId.trim()
              ? cfg.providerId.trim()
              : (typeof p.id === 'string' && p.id.includes('.')
                  ? p.id.split('.')[0]
                  : '');
          if (!provId) continue;

          const rawAuth = providerAuthMap[provId] as any;
          if (!rawAuth || typeof rawAuth !== 'object' || !('type' in rawAuth)) continue;

          const rawType = String(rawAuth.type || '').toLowerCase();
          // 将高层别名类型（iflow-oauth / qwen-oauth）归一为标准 OAuthAuth，
          // 并附带 providerId 以便 OAuth 流程选择正确的默认配置。
          if (rawType === 'iflow-oauth' || rawType === 'qwen-oauth') {
            const family = rawType === 'iflow-oauth' ? 'iflow' : 'qwen';
            const tfRaw = typeof rawAuth.tokenFile === 'string' && rawAuth.tokenFile.trim()
              ? rawAuth.tokenFile.trim()
              : (family === 'iflow'
                  ? path.join(homedir(), '.routecodex', 'auth', 'iflow-oauth.json')
                  : path.join(homedir(), '.routecodex', 'auth', 'qwen-oauth.json'));
            const scopes = Array.isArray(rawAuth.scopes) ? rawAuth.scopes : undefined;
            const clientId = typeof rawAuth.clientId === 'string' && rawAuth.clientId.trim()
              ? rawAuth.clientId.trim()
              : undefined;

            (cfg as any).auth = {
              type: 'oauth',
              clientId,
              // 其余端点/headers 由 provider-oauth-configs 的默认表提供；这里仅允许显式覆盖
              ...(typeof rawAuth.tokenUrl === 'string' && rawAuth.tokenUrl.trim() ? { tokenUrl: rawAuth.tokenUrl.trim() } : {}),
              ...(typeof rawAuth.deviceCodeUrl === 'string' && rawAuth.deviceCodeUrl.trim() ? { deviceCodeUrl: rawAuth.deviceCodeUrl.trim() } : {}),
              ...(typeof rawAuth.userInfoUrl === 'string' && rawAuth.userInfoUrl.trim() ? { userInfoUrl: rawAuth.userInfoUrl.trim() } : {}),
              ...(scopes ? { scopes } : {}),
              tokenFile: tfRaw
            };
            // 为 OAuth 注入专用 providerId，避免与 protocol family 混淆
            const ext = (cfg as any).extensions || {};
            ext.oauthProviderId = family;
            (cfg as any).extensions = ext;
          } else {
            (cfg as any).auth = rawAuth;
          }
          providerModule.config = cfg;
        }
      }
    } catch { /* non-fatal auth injection */ }

    // ⚠️ process/requestProcess/responseProcess 的注入逻辑统一移交给 config-core；
    // ConfigManager 仅负责写回 config-core 生成的 assemblerConfig，不再修改 llmSwitch.config.*
    const mergedWithPac = { ...built.merged, pipeline_assembler: { config: assemblerConfig } } as Record<string, unknown>;
    // 标准输出位置：~/.routecodex/config/generated
    try {
      const outDir = path.join(homedir(), '.routecodex', 'config', 'generated');
      await (await import('fs/promises')).mkdir(outDir, { recursive: true });
      const port = (this.serverPort && Number.isFinite(this.serverPort)) ? this.serverPort : 0;
      const primary = port > 0 ? path.join(outDir, `merged-config.${port}.json`) : path.join(outDir, 'merged-config.generated.json');
      const alias = path.join(outDir, 'merged-config.generated.json');
      await (core as any).writeJsonPretty(primary, mergedWithPac);
      if (alias !== primary) {
        await (core as any).writeJsonPretty(alias, mergedWithPac);
      }
      // 还原 this.mergedConfigPath 指向 alias，供宿主 loadMergedConfig()
      this.mergedConfigPath = alias;
    } catch (e) {
      // 回落到旧路径，但不再做兜底：由上层读取器去 fail-fast
      await (core as any).writeJsonPretty(this.mergedConfigPath, mergedWithPac);
    }
  }

  getStatus(): UnknownObject {
    const info = this.getInfo();
    return {
      id: info.id,
      name: info.name,
      status: this.isRunning() ? 'running' : 'stopped',
      configPath: this.configPath,
      systemConfigPath: this.systemConfigPath,
      mergedConfigPath: this.mergedConfigPath,
      lastUpdated: new Date().toISOString()
    };
  }
}
