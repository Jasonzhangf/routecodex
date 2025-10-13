declare module 'rcc-basemodule' {
  export interface LLMSwitchModule {
    processIncoming(request: any): Promise<any>;
    processOutgoing(response: any): Promise<any>;
    transformRequest(input: any): Promise<any>;
    transformResponse(input: any): Promise<any>;
    initialize(): Promise<void>;
    cleanup(): Promise<void>;
  }

  export interface ModuleConfig {
    id: string;
    type: string;
    config: any;
  }

  export interface ModuleDependencies {
    logger?: any;
    [key: string]: any;
  }
}