import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';

/**
 * Backward-compatible chat provider entry that reuses the new HTTP transport base.
 * Maintains the historic module type id (`openai-standard`) so existing configs keep working.
 */
export class ChatHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    super(config, dependencies, 'openai-standard');
  }
}
