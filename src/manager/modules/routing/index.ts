import type { ManagerContext, ManagerModule } from '../../types.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync
} from '../../../modules/llmswitch/bridge.js';

type RoutingInstructionState = unknown;

export interface RoutingInstructionStateStore {
  loadSync(key: string): RoutingInstructionState | null;
  saveAsync(key: string, state: RoutingInstructionState | null): void;
  saveSync?(key: string, state: RoutingInstructionState | null): void;
}

export class RoutingStateManagerModule implements ManagerModule {
  readonly id = 'routing';

  private stateStore: RoutingInstructionStateStore | null = null;
  private stickyEnabled: boolean | null = null;

  private isStickyEnabled(): boolean {
    if (this.stickyEnabled !== null) {
      return this.stickyEnabled;
    }
    const raw =
      process.env.ROUTECODEX_ENABLE_STICKY ??
      process.env.RCC_ENABLE_STICKY ??
      '';
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const enabled =
      normalized === '1' ||
      normalized === 'true' ||
      normalized === 'yes' ||
      normalized === 'on';
    this.stickyEnabled = enabled;
    return enabled;
  }

  async init(_context: ManagerContext): Promise<void> {
    if (!this.isStickyEnabled()) {
      this.stateStore = null;
      return;
    }
    // Single import surface: llmswitch-core sticky session store is accessed via llmswitch bridge only.
    this.stateStore = {
      loadSync: (key: string) => loadRoutingInstructionStateSync(key) as RoutingInstructionState | null,
      saveAsync: (key: string, state: RoutingInstructionState | null) => {
        saveRoutingInstructionStateAsync(key, state as RoutingInstructionState | null);
      },
      saveSync: (key: string, state: RoutingInstructionState | null) => {
        saveRoutingInstructionStateSync(key, state as RoutingInstructionState | null);
      },
    };
  }

  async start(): Promise<void> {
    // 当前 RoutingStateManager 仅提供 routingStateStore，不需要后台任务。
  }

  async stop(): Promise<void> {
    // 未来如需 compact/迁移 sticky 状态，可在此添加逻辑；当前为 no-op。
  }

  getRoutingStateStore(): RoutingInstructionStateStore | null {
    return this.stateStore;
  }
}
