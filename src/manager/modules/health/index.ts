import fs from 'node:fs';
// feature_id: manager.health_runtime
// canonical_builders: getHealthStore, getCurrentSnapshot, resolveStateDir
import path from 'node:path';
import type { ManagerContext, ManagerModule } from '../../types.js';
import type { ProviderErrorEvent } from '../../../types/llmswitch-local-types.js';
import { JsonlFileStore } from '../../storage/file-store.js';
import { resolveRccPath } from '../../../config/user-data-paths.js';

interface VirtualRouterHealthStore {
  recordProviderError?(event: ProviderErrorEvent): void;
}

export class HealthManagerModule implements ManagerModule {
  readonly id = 'health';

  private serverId: string | null = null;
  private healthStore: VirtualRouterHealthStore | null = null;
  private eventStore: JsonlFileStore<null, ProviderErrorEvent> | null = null;

  async init(context: ManagerContext): Promise<void> {
    this.serverId = context.serverId;
    const baseDir = this.resolveStateDir();
    const filePath = path.join(baseDir, 'health.jsonl');
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    this.eventStore = new JsonlFileStore<null, ProviderErrorEvent>({
      filePath,
      maxAgeMs: sevenDaysMs,
      maxEvents: 1000
    });

    this.healthStore = {
      recordProviderError: (event: ProviderErrorEvent) => {
        const store = this.eventStore;
        if (!store) {
          return;
        }
        void store.append(event).catch(() => {
          // 事件落盘失败忽略
        });
      }
    };
  }

  async start(): Promise<void> {
    // 当前 HealthManager 仅记录 ProviderError 诊断事件，不恢复或持久化 cooldown。
  }

  async stop(): Promise<void> {
    if (this.eventStore) {
      try {
        await this.eventStore.compact();
      } catch {
        // 压缩失败不影响关机流程。
      }
    }
  }

  getHealthStore(): VirtualRouterHealthStore | null {
    return this.healthStore;
  }

  getCurrentSnapshot(): null {
    return null;
  }

  private resolveStateDir(): string {
    const base = resolveRccPath('state', 'router', this.serverId || 'default');
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      // best effort
    }
    return base;
  }
}
