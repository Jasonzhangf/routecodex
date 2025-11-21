export type HookStage = 'request_preprocessing' | 'response_validation' | 'error_handling';

export interface HookContext {
  endpoint: string;
  requestId?: string;
  routeName?: string;
}

export class HooksIntegration {
  private enabled: boolean;

  constructor(opts?: { enabled?: boolean }) {
    this.enabled = opts?.enabled !== false;
  }

  isEnabled(): boolean { return this.enabled; }

  async executeStage(stage: HookStage, data: unknown, ctx?: HookContext): Promise<void> {
    if (!this.enabled) return;
    try {
      // 轻量封装：当前仅做最小日志与容错，不与 handlers 快照冲突
      const info = {
        stage,
        endpoint: ctx?.endpoint,
        requestId: ctx?.requestId,
        routeName: ctx?.routeName,
      };
      // 使用 console 而非快照，避免重复写入
      // eslint-disable-next-line no-console
      console.log('[HooksIntegration] stage', info);
    } catch {
      // no-op
    }
  }
}

