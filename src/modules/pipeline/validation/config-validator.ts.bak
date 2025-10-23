/**
 * Configuration validation utilities
 */

import type { PipelineConfig, ModuleConfig } from '../interfaces/pipeline-interfaces.js';

/**
 * Validate pipeline configuration
 */
export function validatePipelineConfig(config: PipelineConfig): void {
  if (!config.id) {
    throw new Error('Pipeline configuration must have an ID');
  }
  if (!config.provider) {
    throw new Error('Pipeline configuration must have a provider');
  }
  if (!config.modules) {
    throw new Error('Pipeline configuration must have modules');
  }
}

/**
 * Validate module configuration
 */
export function validateModuleConfig(config: ModuleConfig): void {
  if (!config.type) {
    throw new Error('Module configuration must have a type');
  }
  if (!config.config) {
    throw new Error('Module configuration must have config');
  }
}

/**
 * Validate provider configuration
 */
export function validateProviderConfig(config: any): void {
  if (!config.type) {
    throw new Error('Provider configuration must have a type');
  }
  if (!config.baseUrl) {
    throw new Error('Provider configuration must have a baseUrl');
  }
}