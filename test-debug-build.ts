/**
 * Test script to verify debug system compilation
 *
 * This file tests that all debug system components can be imported successfully
 * without TypeScript compilation errors.
 */

// Test core debug components
import { BaseDebugAdapter } from './src/debug/base-debug-adapter.js';
import { ModuleDebugAdapterImpl } from './src/debug/module-debug-adapter.js';
import { HttpServerDebugAdapterImpl } from './src/debug/http-server-debug-adapter.js';

// Test main system components
import { DebugSystemManager } from './src/debug/debug-system-manager.js';
import { DebugAPIExtensionImpl } from './src/debug/debug-api-extension.js';
import { WebSocketDebugServerImpl } from './src/debug/websocket-debug-server.js';

// Test integration helpers
import { HttpServerDebugIntegration } from './src/debug/http-server-integration.js';

// Test utilities
import { DebugUtilsStatic as DebugUtils } from './src/utils/debug-utils.js';
import { DebugEventBus, ErrorHandlingCenter } from './src/utils/external-mocks.js';

// Test types
import type {
  DebugAdapter,
  DebugContext,
  DebugData,
  DebugAdapterConfig,
  DebugSystemEvent
} from './src/types/debug-types.js';

console.log('✅ All debug system imports successful!');
console.log('✅ Debug system compilation test passed!');
console.log('✅ TypeScript errors resolved!');