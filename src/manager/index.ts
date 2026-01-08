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

  async start(): Promise<void> {
    for (const module of this.modules.values()) {
      await module.init(this.context);
    }
    for (const module of this.modules.values()) {
      await module.start();
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

