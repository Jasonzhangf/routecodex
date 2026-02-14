import type { ManagerContext, ManagerModule } from './types.js';

export class ManagerDaemon {
  private readonly context: ManagerContext;
  private readonly modules: Map<string, ManagerModule> = new Map();

  constructor(context: ManagerContext) {
    this.context = context;
  }

  registerModule(module: ManagerModule): void {
    this.modules.set(module.id, module);
  }

  private resolveModuleTimeoutMs(): number {
    const raw = String(process.env.ROUTECODEX_MANAGER_MODULE_TIMEOUT_MS || '').trim();
    if (!raw) return 30_000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
    return Math.floor(parsed);
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    if (!ms || ms <= 0) {
      return await promise;
    }
    let t: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(label)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (t) {
        clearTimeout(t);
      }
    }
  }

  async start(): Promise<void> {
    const timeoutMs = this.resolveModuleTimeoutMs();
    for (const module of this.modules.values()) {
      const startedAt = Date.now();
      // eslint-disable-next-line no-console
      // [ManagerDaemon] init start removed
      await this.withTimeout(
        Promise.resolve(module.init(this.context)),
        timeoutMs,
        `[ManagerDaemon] init timeout module=${module.id} after ${timeoutMs}ms`
      );
      // eslint-disable-next-line no-console
      // [ManagerDaemon] init ok removed
    }
    for (const module of this.modules.values()) {
      const startedAt = Date.now();
      // eslint-disable-next-line no-console
      // [ManagerDaemon] start begin removed
      await this.withTimeout(
        Promise.resolve(module.start()),
        timeoutMs,
        `[ManagerDaemon] start timeout module=${module.id} after ${timeoutMs}ms`
      );
      // eslint-disable-next-line no-console
      // [ManagerDaemon] start ok removed
    }
  }

  async stop(): Promise<void> {
    for (const module of this.modules.values()) {
      await module.stop();
    }
  }

  getModule(id: string): ManagerModule | undefined {
    return this.modules.get(id);
  }
}
