/**
 * RouteCodex Debug System - Main Exports
 *
 * This file exports all the main components of the RouteCodex debugging system
 * for easy integration and usage.
 */

// Type exports
export type {
  DebugSystemOptions,
  DebugAdapterConfig,
  DebugAdapter,
  DebugContext,
  DebugData,
  DebugAdapterHealth,
  DebugAdapterStats,
  DebugHealthIssue,
  ModuleDebugAdapter,
  MethodHookOptions,
  MethodHookData,
  ModuleDebugData,
  HttpServerDebugAdapter,
  DebugHttpRequest,
  DebugHttpResponse,
  HttpDebugData,
  DebugAPIExtension,
  DebugAPIRequest,
  DebugAPIResponse,
  DebugExtensionHealth,
  WebSocketDebugServer,
  DebugWebSocketEvent,
  DebugWebSocketMessage,
  WebSocketServerStats,
  WebSocketServerHealth,

  SanitizeOptions,
  FormatOptions,
  PerformanceMarker,
  DebugConfiguration,
  DebugSystemEvent,
  DebugSystemHealth
} from '../types/debug-types.js';

// Base classes
export { BaseDebugAdapter } from './base-debug-adapter.js';
export { ModuleDebugAdapterImpl } from './module-debug-adapter.js';
export { HttpServerDebugAdapterImpl } from './http-server-debug-adapter.js';

// Main components
export { DebugSystemManager, debugSystemManager } from './debug-system-manager.js';
export { DebugAPIExtensionImpl } from './debug-api-extension.js';
export { WebSocketDebugServerImpl } from './websocket-debug-server.js';

// Integration helpers
export { HttpServerDebugIntegration, createHttpServerDebugIntegration } from './http-server-integration.js';

// Utilities
export { DebugUtilsStatic as DebugUtils, DebugUtilsImpl } from '../utils/debug-utils.js';

// Re-export external types for convenience
export type { DebugEvent } from 'rcc-debugcenter';
export type { ErrorContext } from 'rcc-errorhandling';

/**
 * Quick setup function for the debug system
 */
export async function setupDebugSystem(options?: {
  enableRestApi?: boolean;
  enableWebSocket?: boolean;
  restPort?: number;
  wsPort?: number;
  adapters?: DebugAdapterConfig[];
}): Promise<DebugSystemManager> {
  const debugManager = DebugSystemManager.getInstance({
    enableRestApi: options?.enableRestApi ?? false,
    enableWebSocket: options?.enableWebSocket ?? false,
    restPort: options?.restPort ?? 8080,
    wsPort: options?.wsPort ?? 8081,
    adapters: options?.adapters || []
  });

  await debugManager.initialize();
  return debugManager;
}

/**
 * Quick setup for HTTP server debugging
 */
export async function setupHttpServerDebug(
  serverInfo: {
    host: string;
    port: number;
    protocol: string;
  },
  debugManager?: DebugSystemManager
): Promise<HttpServerDebugIntegration> {
  const integration = new HttpServerDebugIntegration(serverInfo, undefined, debugManager);
  await integration.initialize();
  return integration;
}

/**
 * Quick setup for module debugging
 */
export async function setupModuleDebug(
  moduleInfo: {
    id: string;
    name: string;
    version: string;
    type: string;
  },
  debugManager?: DebugSystemManager
): Promise<ModuleDebugAdapterImpl> {
  const manager = debugManager || DebugSystemManager.getInstance();
  await manager.initialize();
  return await manager.createModuleAdapter(
    moduleInfo.id,
    moduleInfo
  );
}

// Default export
export default {
  DebugSystemManager,
  debugSystemManager,
  setupDebugSystem,
  setupHttpServerDebug,
  setupModuleDebug,
  HttpServerDebugIntegration,
  createHttpServerDebugIntegration,
  DebugUtils
};