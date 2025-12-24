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
    error: string | Error | Record<string, unknown>;
    source: string;
    severity: 'low' | 'medium' | 'high' | 'critical' | string;
    timestamp: number;
    moduleId?: string;
    context?: Record<string, unknown>;
  };
  export type ErrorResponse = {
    success: boolean;
    message: string;
    actionTaken?: string;
    timestamp: number;
    errorId?: string;
  };
  export class ErrorHandlingCenter {
    constructor(info?: Record<string, unknown>);
    initialize(): Promise<void>;
    handleError(context: ErrorContext): Promise<ErrorResponse>;
    handleErrorAsync(context: ErrorContext): void;
    handleBatchErrors(contexts: ErrorContext[]): Promise<ErrorResponse[]>;
    destroy(): Promise<void>;
    getHealth(): Record<string, unknown>;
    getStats(): Record<string, unknown>;
    resetErrorCount(): void;
  }
}
