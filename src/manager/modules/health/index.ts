import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ManagerContext, ManagerModule } from '../../types.js';
import type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { JsonlFileStore } from '../../storage/file-store.js';

type VirtualRouterHealthSnapshot = unknown;

interface VirtualRouterHealthStore {
  loadInitialSnapshot(): VirtualRouterHealthSnapshot | null;
  persistSnapshot?(snapshot: VirtualRouterHealthSnapshot): void;
  recordProviderError?(event: ProviderErrorEvent): void;
}

export class HealthManagerModule implements ManagerModule {
  readonly id = 'health';

  private serverId: string | null = null;
  private healthStore: VirtualRouterHealthStore | null = null;
  private snapshotStore: JsonlFileStore<VirtualRouterHealthSnapshot, ProviderErrorEvent> | null = null;
  private initialSnapshot: VirtualRouterHealthSnapshot | null = null;

  async init(context: ManagerContext): Promise<void> {
    this.serverId = context.serverId;
    const baseDir = this.resolveStateDir();
    const filePath = path.join(baseDir, 'health.jsonl');
    // 默认保留最近 7 天的 ProviderError 事件，最多 1000 条，防止无限膨胀。
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    this.snapshotStore = new JsonlFileStore<VirtualRouterHealthSnapshot, ProviderErrorEvent>({
      filePath,
      maxAgeMs: sevenDaysMs,
      maxEvents: 1000
    });
    try {
      this.initialSnapshot = await this.snapshotStore.load();
    } catch {
      this.initialSnapshot = null;
    }

    this.healthStore = {
      loadInitialSnapshot: () => this.initialSnapshot,
      persistSnapshot: (snapshot: VirtualRouterHealthSnapshot) => {
        this.initialSnapshot = snapshot;
        const store = this.snapshotStore;
        if (!store) {
          return;
        }
        void store.save(snapshot).catch(() => {
          // 持久化失败不影响主流程
        });
      },
      recordProviderError: (event: ProviderErrorEvent) => {
        const store = this.snapshotStore;
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
    // 当前 HealthManager 仅提供 VirtualRouterHealthStore，不需要单独的后台任务。
  }

  async stop(): Promise<void> {
    // Server 停止时做一次 best-effort 压缩，清理过期事件记录。
    if (this.snapshotStore) {
      try {
        await this.snapshotStore.compact();
      } catch {
        // 压缩失败不影响关机流程
      }
    }
  }

  getHealthStore(): VirtualRouterHealthStore | null {
    return this.healthStore;
  }

  private resolveStateDir(): string {
    const base = path.join(
      homedir(),
      '.routecodex',
      'state',
      'router',
      this.serverId || 'default'
    );
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      // best effort
    }
    return base;
  }
}
