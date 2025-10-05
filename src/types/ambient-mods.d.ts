// Ambient module declarations to satisfy external packages missing types
// Keep the surface minimal and permissive to allow compilation.

declare module 'rcc-basemodule' {
  export type ModuleInfo = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    type?: string;
  };
  export class BaseModule {
    constructor(info: ModuleInfo);
    getInfo(): ModuleInfo;
    isRunning(): boolean;
  }
}

declare module 'rcc-debugcenter' {
  export class DebugCenter {}
  export class DebugEventBus {
    static getInstance(): DebugEventBus;
    publish(_event: UnknownObject): void;
    subscribe(topic: string, _handler: (_event: UnknownObject) => void): void;
  }
}

declare module 'rcc-errorhandling' {
  export type ErrorContext = {
    error: string | Error;
    source: string;
    severity: 'low' | 'medium' | 'high' | 'critical' | string;
    timestamp: number;
    moduleId?: string;
    context?: Record<string, unknown>;
  };
  export class ErrorHandlingCenter {
    initialize(): Promise<void>;
    handleError(_context: UnknownObject): Promise<void>;
    destroy(): Promise<void>;
  }
}
