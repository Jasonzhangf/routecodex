/**
 * Minimal DebugEventBus shim (no-op).
 *
 * 目标：彻底去除对 debugcenter 模块的依赖，但保留统一的事件发布接口，
 * 以满足现有代码的类型与调用约定。默认静默；仅用于本地 dev/worktree。
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

import { isDebugCenterEnabled } from './flags.js';

export class DebugEventBus {
  private static instance: DebugEventBus = new DebugEventBus();
  private warnedDisabled = false;

  static getInstance(): DebugEventBus {
    return DebugEventBus.instance;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  publish(_event: DebugEventPayload): void {
    // 默认静默；当明确开启了 DebugCenter（通过变量），但 shim 仍在工作，给出一次性提示。
    try {
      if (isDebugCenterEnabled() && !this.warnedDisabled) {
        this.warnedDisabled = true;
        // eslint-disable-next-line no-console
        console.warn('[DebugCenter] DebugCenter is marked enabled but real backend is not wired (shim active). Using no-op.');
      }
    } catch { /* ignore */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe(_subscriptionId: string, _handler: (event: DebugEventPayload) => void): void {
    // 接口占位，保持静默
  }
}
