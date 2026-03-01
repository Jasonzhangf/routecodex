export interface ManagerContext {
  serverId: string;
  configPath?: string;
  /**
   * Whether quota management participates in virtual-router routing decisions.
   * When false, quota modules should not emit quota signals or maintain quota-based pool states.
   */
  quotaRoutingEnabled?: boolean;
}

export interface ManagerModule {
  id: string;
  init(context: ManagerContext): Promise<void> | void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
