/**
 * Config Manager Module (config-core only)
 * 仅依赖 rcc-config-core 生成 merged-config 与 V2 装配输入
 */

import { BaseModule } from 'rcc-basemodule';
import type { UnknownObject } from '../../types/common-types.js';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';
import path from 'path';
import { homedir } from 'os';

export class ConfigManagerModule extends BaseModule {
  private configPath: string;
  private systemConfigPath: string;
  private mergedConfigPath: string;
  private authFileResolver: AuthFileResolver;

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
    // 兼容导入 rcc-config-core（不同安装形态：exports 入口 / 显式 dist / 按子模块聚合）
    const core = await (async () => {
      const tryImport = async (spec: string): Promise<any> => {
        // 通过计算得来的 spec 避免 TS 类型检查器要求类型声明
        return await import(spec as any);
      };
      try {
        return await tryImport('rcc-config-core');
      } catch {
        try {
          // 显式入口（有些环境的解析器更偏好具体路径）
          return await tryImport('rcc-config-core/dist/index.js');
        } catch {
          // 子模块聚合兜底（仍然只依赖 config-core，不回退到 legacy 实现）
          const [loaders, canonical, asm, merged] = await Promise.all([
            tryImport('rcc-config-core/interpreter/loaders.js'),
            tryImport('rcc-config-core/interpreter/build-canonical.js'),
            tryImport('rcc-config-core/exporters/export-assembler-v2.js'),
            tryImport('rcc-config-core/exporters/build-merged.js'),
          ]);
          return {
            loadSystemConfig: loaders.loadSystemConfig,
            loadUserConfig: loaders.loadUserConfig,
            writeJsonPretty: loaders.writeJsonPretty,
            buildCanonical: canonical.buildCanonical,
            exportAssemblerConfigV2: asm.exportAssemblerConfigV2,
            buildMergedConfig: merged.buildMergedConfig,
            writeMerged: merged.writeMerged,
          } as unknown as {
            loadSystemConfig: (p: string) => Promise<any>;
            loadUserConfig: (p: string) => Promise<any>;
            writeJsonPretty: (p: string, d: unknown) => Promise<void>;
            buildCanonical: (s: any, u: any, o?: any) => any;
            exportAssemblerConfigV2: (c: any) => any;
            buildMergedConfig: (c: any) => any;
            writeMerged: (p: string, m: any) => Promise<void>;
          };
        }
      }
    })();
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
    const canonical = core.buildCanonical(sys?.ok ? sys : { ok: true, data: {} }, usr, { keyDimension: 'perKey' } as any);
    let assemblerConfig: any = core.exportAssemblerConfigV2(canonical);
    const built = core.buildMergedConfig(canonical);
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
    const mergedWithPac = { ...built.merged, pipeline_assembler: { config: assemblerConfig } } as Record<string, unknown>;
    await core.writeMerged(this.mergedConfigPath, mergedWithPac);
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
