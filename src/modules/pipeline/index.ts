/**
 * RouteCodex Pipeline Module Exports
 *
 * Clean exports for all pipeline functionality including:
 * - Core pipeline components (BasePipeline, PipelineManager)
 * - Module interfaces and types
 * - Utility functions and classes
 * - Transformation engine
 * - Debug logging and error handling
 */

// Core pipeline components
export { BasePipeline } from './core/base-pipeline.js';
export { PipelineManager } from './core/pipeline-manager.js';

// Pipeline interfaces and types
export type {
  PipelineRequest,
  PipelineResponse,
  PipelineConfig,
  PipelineManagerConfig,
  PipelineModuleRegistry,
  ModuleFactory,
  ModuleConfig,
  ModuleDependencies,
  PipelineModule,
  TransformationRule,
  TransformationLog,
  PipelineStatus,
  LLMSwitchModule,
  WorkflowModule,
  CompatibilityModule,
  ProviderModule
} from './interfaces/pipeline-interfaces.js';

// Module registry and registrar
export { PipelineModuleRegistryImpl } from './core/pipeline-registry.js';
export { ModuleRegistrar } from './core/module-registrar.js';

// Configuration management
export { PipelineConfigManager } from './config/pipeline-config-manager.js';

// Debug logging and error handling
export { PipelineDebugLogger } from './utils/debug-logger.js';
export { PipelineErrorIntegration } from './utils/error-integration.js';

// Transformation engine
export { createTransformationEngine } from './utils/transformation-engine.js';
export type { TransformationEngineConfig } from './types/transformation-types.js';

// Provider types
export type {
  ProviderConfig,
  ProviderStatus,
  AuthContext,
  ProviderResponse,
  ProviderError,
  ProviderMetrics
} from './types/provider-types.js';

// External types (for convenience)
export type {
  RCCBaseModule,
  ErrorHandlingCenter,
  DebugCenter
} from './types/external-types.js';

// Utility types and helper functions
export * from './types/pipeline-types.js';

// Pipeline creation helpers (when implemented)
// export { createPipeline } from './utils/pipeline-creator.js';

// Module factories (when implemented)
// export {
//   createLLMSwitchModule,
//   createCompatibilityModule,
//   createProviderModule,
//   createWorkflowModule
// } from './factories/module-factories.js';

// Default configurations (when implemented)
// export { defaultPipelineConfig } from './config/default-config.js';

// Error handling utilities (when implemented)
// export {
//   PipelineError,
//   PipelineErrorCode,
//   createPipelineError,
//   isPipelineError
// } from './errors/pipeline-errors.js';

// Validation utilities (when implemented)
// export {
//   validatePipelineConfig,
//   validateModuleConfig,
//   validateProviderConfig
// } from './validation/config-validator.js';

// Performance monitoring (when implemented)
// export {
//   PipelineMetrics,
//   PipelinePerformanceMonitor,
//   createPerformanceMonitor
// } from './monitoring/performance-monitor.js';

// Plugin system (when implemented)
// export {
//   PipelinePlugin,
//   PipelinePluginManager,
//   createPluginManager
// } from './plugins/plugin-system.js';

// Testing utilities (when implemented)
// export {
//   createMockPipeline,
//   createTestPipelineConfig,
//   createTestModuleDependencies
// } from './testing/test-utils.js';

// Version information
export const PIPELINE_MODULE_VERSION = '1.0.0';
export const PIPELINE_API_VERSION = '1.0.0';



// Export everything from core interfaces for full access
export * from './interfaces/pipeline-interfaces.js';