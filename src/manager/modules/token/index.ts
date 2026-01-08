import type { ManagerContext, ManagerModule } from '../../types.js';

export class TokenManagerModule implements ManagerModule {
  readonly id = 'token';

  async init(_context: ManagerContext): Promise<void> {
    // Token 管理具体逻辑后续从现有 token daemon 迁移进来。
  }

  async start(): Promise<void> {
    // 占位实现
  }

  async stop(): Promise<void> {
    // 占位实现
  }
}

