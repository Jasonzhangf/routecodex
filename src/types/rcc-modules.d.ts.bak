/**
 * RCC module type declarations
 */

// import { UnknownObject } from './common-types';

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
  import { UnknownObject } from './common-types';
  
  export interface DebugEvent {
    sessionId: string;
    moduleId: string;
    operationId: string;
    timestamp: number;
    type: 'start' | 'end' | 'error';
    position: 'start' | 'middle' | 'end';
    data?: UnknownObject;
  }

  export class DebugEventBus {
    static getInstance(): DebugEventBus;
    publish(event: DebugEvent): void;
    subscribe(eventType: string, callback: Function): void;
  }
}

declare module 'rcc-errorhandling' {
  import { UnknownObject } from './common-types';
  
  export interface ErrorContext {
    error: Error | string;
    source: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp: number;
    moduleId?: string;
    context?: UnknownObject;
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
    getHealth(): UnknownObject;
    getStats(): UnknownObject;
    resetErrorCount(): void;
  }
}