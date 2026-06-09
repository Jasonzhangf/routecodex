import type { ModuleDependencies } from '../modules/pipeline/interfaces/pipeline-interfaces.js';
import { HarnessRegistry } from './harness-registry.js';
import { ProviderPreprocessHarness } from './harnesses/provider-harness.js';

export interface DefaultHarnessOptions {
  providerDependencies?: ModuleDependencies;
}

export function createDefaultHarnessRegistry(options: DefaultHarnessOptions = {}): HarnessRegistry {
  const registry = new HarnessRegistry();
  registry.register(new ProviderPreprocessHarness(options.providerDependencies));
  return registry;
}
