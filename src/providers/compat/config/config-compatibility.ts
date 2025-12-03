import type { CompatibilityModule } from '../compatibility-interface.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from '../compatibility-interface.js';
import { BaseCompatibility } from '../base-compatibility.js';

/**
 * 通用配置兼容模块（纯配置）
 * - 默认直通（不修改请求/响应）
 * - 当提供 shapeFilterConfigPath 时，按 JSON 规格执行拍平/解包/白名单/补齐
 * - hooks 仅用于未定义的特殊行为（可选）
 */
export class ConfigCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'config-compatibility';

  private deps: ModuleDependencies;
  private base: BaseCompatibility | null = null;
  private cfg: { shapeFilterConfigPath?: string; providerAlias?: string };

  constructor(dependencies: ModuleDependencies, config?: { shapeFilterConfigPath?: string; providerAlias?: string }) {
    this.deps = dependencies;
    this.id = `compat-config-${Date.now()}`;
    this.cfg = config || {};
  }

  async initialize(): Promise<void> {
    // 默认直通：不提供任何配置则不改形状
    let pathToJson = this.cfg.shapeFilterConfigPath;
    if (!pathToJson && this.cfg.providerAlias) {
      // 动态加载：定位到当前模块目录，拼接 provider 的内置 JSON
      // dist 路径：dist/providers/compat/config/config-compatibility.js
      // 目标路径：dist/providers/compat/<providerAlias>/config/shape-filters.json
      try {
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const candidate = join(__dirname, '..', this.cfg.providerAlias, 'config', 'shape-filters.json');
        pathToJson = candidate;
      } catch { /* fallback below */ }
    }
    if (pathToJson) {
      this.base = new BaseCompatibility(this.deps, {
        providerType: this.cfg.providerAlias || 'generic',
        shapeFilterConfigPath: pathToJson
      });
      await this.base.initialize();
    }
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    if (!this.base) { return request; }
    return await this.base.processIncoming(request, context);
  }

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    // 兼容 provider 响应包装：{ data, status, headers }
    let payload = response as any;
    if (payload && typeof payload === 'object' && ('data' in payload) && ('status' in payload)) {
      payload = (payload as any).data ?? payload;
    }
    if (!this.base) { return payload; }
    return await this.base.processOutgoing(payload as UnknownObject, context);
  }

  async cleanup(): Promise<void> { /* no-op */ }
}
