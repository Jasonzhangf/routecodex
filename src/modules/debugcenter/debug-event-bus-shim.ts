/**
 * Minimal DebugEventBus shim.
 *
 * 用于替代 rcc-debugcenter 的 DebugEventBus，仅在 dev/worktree 场景下
 * 提供基本的事件发布接口，默认静默（可按需开启 console.debug）。
 */

export interface DebugEventPayload {
  sessionId: string;
  moduleId: string;
  operationId: string;
  timestamp: number;
  type: string;
  position: string;
  data: Record<string, unknown>;
}

export class DebugEventBus {
  private static instance: DebugEventBus = new DebugEventBus();

  static getInstance(): DebugEventBus {
    return DebugEventBus.instance;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  publish(_event: DebugEventPayload): void {
    // 本地 dev 环境默认静默；如需调试可改为 console.debug
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe(_subscriptionId: string, _handler: (event: DebugEventPayload) => void): void {
    // 订阅接口占位，实现上保持静默
  }
}
