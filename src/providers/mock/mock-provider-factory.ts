/**
 * Mock Provider Factory
 */
import type { OpenAIStandardConfig } from '../core/api/provider-config.js';
import type { ModuleDependencies } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { MockProvider } from './mock-provider.js';

export function createMockProvider(config: OpenAIStandardConfig, dependencies: ModuleDependencies): MockProvider {
  return new MockProvider(config, dependencies);
}
