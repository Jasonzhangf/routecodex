import type { ManagerContext, ManagerModule } from '../../types.js';

export class RoutingStateManagerModule implements ManagerModule {
  readonly id = 'routing';

  async init(_context: ManagerContext): Promise<void> {
    // 后续负责 session/sticky 级路由状态的持久化。
  }

  async start(): Promise<void> {
    // 占位实现
  }

  async stop(): Promise<void> {
    // 占位实现
  }
}

