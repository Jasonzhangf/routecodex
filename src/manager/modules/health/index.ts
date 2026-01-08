import type { ManagerContext, ManagerModule } from '../../types.js';

export class HealthManagerModule implements ManagerModule {
  readonly id = 'health';

  async init(_context: ManagerContext): Promise<void> {
    // 后续将实现 VirtualRouterHealthStore 的桥接与持久化。
  }

  async start(): Promise<void> {
    // 占位实现
  }

  async stop(): Promise<void> {
    // 占位实现
  }
}

