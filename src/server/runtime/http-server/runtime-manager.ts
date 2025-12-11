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
