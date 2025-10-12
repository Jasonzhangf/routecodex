export interface RCCBaseModule {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  getStatus(): any;
}

export interface ErrorHandlingCenter {
  handleError(error: any, context?: any): Promise<void>;
  createContext(module: string, action: string, data?: any): any;
  getStatistics(): any;
}

export interface DebugCenter {
  logDebug(module: string, message: string, data?: any): void;
  logError(module: string, error: any, context?: any): void;
  logModule(module: string, action: string, data?: any): void;
  processDebugEvent(event: DebugEvent): void;
  getLogs(module?: string): any[];
}

export interface DebugEvent {
  sessionId?: string;
  moduleId: string;
  operationId: string;
  timestamp: number;
  type: 'start' | 'end' | 'error';
  position: 'start' | 'middle' | 'end';
  data?: any;
}

