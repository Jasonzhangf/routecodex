/**
 * RCC module type declarations
 */

declare module 'rcc-basemodule' {
  export interface ModuleInfo {
    id: string;
    name: string;
    version: string;
    description: string;
    type?: string;
  }

  export class BaseModule {
    constructor(moduleInfo: ModuleInfo);
    getModuleInfo(): ModuleInfo;
    getInfo(): ModuleInfo;
    isInitialized(): boolean;
    isRunning(): boolean;
  }
}

declare module 'rcc-debugcenter' {
  export interface DebugEvent {
    sessionId: string;
    moduleId: string;
    operationId: string;
    timestamp: number;
    type: 'start' | 'end' | 'error';
    position: 'start' | 'middle' | 'end';
    data?: any;
  }

  export class DebugEventBus {
    static getInstance(): DebugEventBus;
    publish(event: DebugEvent): void;
    subscribe(eventType: string, callback: Function): void;
  }
}

declare module 'rcc-errorhandling' {
  export interface ErrorContext {
    error: Error | string;
    source: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp: number;
    moduleId?: string;
    context?: Record<string, any>;
  }

  export interface ErrorResponse {
    success: boolean;
    message: string;
    actionTaken?: string;
    timestamp: number;
    errorId?: string;
  }

  export class ErrorHandlingCenter {
    constructor();
    initialize(): Promise<void>;
    handleError(error: ErrorContext): Promise<ErrorResponse>;
    handleErrorAsync(error: ErrorContext): void;
    handleBatchErrors(errors: ErrorContext[]): Promise<ErrorResponse[]>;
    destroy(): Promise<void>;
    getHealth(): any;
    getStats(): any;
    resetErrorCount(): void;
  }
}
