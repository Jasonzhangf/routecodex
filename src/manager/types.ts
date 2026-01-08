export interface ManagerContext {
  serverId: string;
}

export interface ManagerModule {
  id: string;
  init(context: ManagerContext): Promise<void> | void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

