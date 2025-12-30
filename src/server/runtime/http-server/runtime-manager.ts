import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { ProviderHandle } from './types.js';

export type ProviderRuntimeManagerDeps = {
  createHandle(runtimeKey: string, runtime: ProviderRuntimeProfile): Promise<ProviderHandle>;
  materializeRuntime(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile>;
  applyOverrides?(runtime: ProviderRuntimeProfile): ProviderRuntimeProfile;
};

type RuntimeMap = Record<string, ProviderRuntimeProfile | undefined>;

export class ProviderRuntimeManager {
  private readonly deps: ProviderRuntimeManagerDeps;
  private readonly handles = new Map<string, ProviderHandle>();
  private readonly providerKeyToRuntimeKey = new Map<string, string>();

  constructor(deps: ProviderRuntimeManagerDeps) {
    this.deps = deps;
  }

  async initialize(runtimeMap?: RuntimeMap): Promise<void> {
    if (!runtimeMap) {
      return;
    }
    await this.disposeAll();
    this.providerKeyToRuntimeKey.clear();
    for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
      if (!runtime) {
        continue;
      }
      const runtimeKey = runtime.runtimeKey || providerKey;
      if (!this.handles.has(runtimeKey)) {
        const prepared = await this.prepareRuntime(runtime);
        const handle = await this.deps.createHandle(runtimeKey, prepared);
        this.handles.set(runtimeKey, handle);
      }
      this.providerKeyToRuntimeKey.set(providerKey, runtimeKey);
      // 为 server-side 工具（例如 web_search）提供 providerKey「别名」支持。
      // 典型场景：虚拟路由使用聚合 key（如 gemini-cli.gemini-2.5-flash-lite）作为
      // web_search backend，而实际 runtime key 包含用户别名前缀
      //（如 gemini-cli.1-jasonzhangfan.gemini-2.5-flash-lite）。
      // 这里在不影响现有映射的前提下，补充一条别名映射，保证诸如 servertool
      // 这类仅持有聚合 providerKey 的调用方，仍能通过 runtimeManager 找到实际 runtime。
      if (providerKey.startsWith('gemini-cli.')) {
        const parts = providerKey.split('.');
        // 期望形态：gemini-cli.<user-alias>.<model-id-with-dots>
        // 聚合 key 形态：gemini-cli.<model-id-with-dots>
        if (parts.length >= 4) {
          const aliasSuffix = parts.slice(2).join('.');
          const aliasKey = `${parts[0]}.${aliasSuffix}`;
          if (!this.providerKeyToRuntimeKey.has(aliasKey)) {
            this.providerKeyToRuntimeKey.set(aliasKey, runtimeKey);
          }
        }
      }
    }
  }

  resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined {
    if (providerKey && this.providerKeyToRuntimeKey.has(providerKey)) {
      return this.providerKeyToRuntimeKey.get(providerKey);
    }
    return fallback;
  }

  getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined {
    if (!runtimeKey) {
      return undefined;
    }
    return this.handles.get(runtimeKey);
  }

  getHandleByProviderKey(providerKey: string): ProviderHandle | undefined {
    return this.getHandleByRuntimeKey(this.providerKeyToRuntimeKey.get(providerKey));
  }

  async disposeAll(): Promise<void> {
    const handles = Array.from(this.handles.values());
    await Promise.all(
      handles.map(async handle => {
        try {
          await handle.instance.cleanup();
        } catch {
          /* ignore cleanup errors */
        }
      })
    );
    this.handles.clear();
  }

  private async prepareRuntime(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile> {
    const materialized = await this.deps.materializeRuntime(runtime);
    const applyOverrides = this.deps.applyOverrides;
    return applyOverrides ? applyOverrides(materialized) : materialized;
  }
}

export function createProviderRuntimeManager(deps: ProviderRuntimeManagerDeps): ProviderRuntimeManager {
  return new ProviderRuntimeManager(deps);
}
