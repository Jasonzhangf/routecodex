import type { ManagerContext, ManagerModule } from '../../types.js';

type RoutingInstructionState = unknown;

export interface RoutingInstructionStateStore {
  loadSync(key: string): RoutingInstructionState | null;
  saveAsync(key: string, state: RoutingInstructionState | null): void;
}

export class RoutingStateManagerModule implements ManagerModule {
  readonly id = 'routing';

  private stateStore: RoutingInstructionStateStore | null = null;

  async init(_context: ManagerContext): Promise<void> {
    // 初始版本：通过 require 动态加载 llmswitch-core 的 sticky-session 存取函数，
    // 并包装为 VirtualRouterEngine 所需的 routingStateStore 接口。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires,global-require
      const mod = require('@jsonstudio/llms/dist/router/virtual-router/sticky-session-store.js') as {
        loadRoutingInstructionStateSync?: (key: string) => RoutingInstructionState | null;
        saveRoutingInstructionStateAsync?: (key: string, state: RoutingInstructionState | null) => void;
      };
      const loadFn = typeof mod?.loadRoutingInstructionStateSync === 'function'
        ? mod.loadRoutingInstructionStateSync
        : undefined;
      const saveFn = typeof mod?.saveRoutingInstructionStateAsync === 'function'
        ? mod.saveRoutingInstructionStateAsync
        : undefined;
      if (!loadFn || !saveFn) {
        this.stateStore = null;
        return;
      }
      this.stateStore = {
        loadSync: (key: string) => loadFn(key),
        saveAsync: (key: string, state: RoutingInstructionState | null) => {
          saveFn(key, state as any);
        }
      };
    } catch {
      this.stateStore = null;
    }
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
