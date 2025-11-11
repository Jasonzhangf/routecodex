/**
 * Scenario Builder - Base interface for building test scenarios
 * 
 * Provides clean architecture for creating test scenarios
 * from various data sources without circular dependencies.
 */

import type { TestScenario, TestEndpoint, TestProvider, PipelineRequest } from './types.js';

/**
 * Base scenario builder
 */
export abstract class ScenarioBuilder {
  protected readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Build test scenarios
   */
  abstract buildScenarios(): Promise<TestScenario[]>;

  /**
   * Convert pipeline request to test scenario
   */
  protected createScenario(
    id: string,
    name: string,
    description: string,
    endpoint: TestEndpoint,
    provider: TestProvider,
    request: PipelineRequest,
    expectedOutput?: any
  ): TestScenario {
    return {
      id,
      name,
      description,
      endpoint,
      provider,
      requests: [request],
      expectedOutput: expectedOutput || {
        status: 200,
        hasContent: !!request.messages?.length,
        hasChoices: endpoint === 'chat',
        hasToolCalls: !!request.tools?.length,
        isStreaming: !!request.stream
      }
    };
  }
}

/**
 * Factory for creating scenario builders
 */
export function createScenarioBuilder(type: 'samples' | 'config' | 'dryrun'): ScenarioBuilder {
  switch (type) {
    case 'samples':
      return new SampleBasedBuilder();
    case 'config':
      return new ConfigBasedBuilder();
    case 'dryrun':
      return new DryRunBuilder();
    default:
      throw new Error(`Unknown scenario builder type: ${type}`);
  }
}

/**
 * Sample-based scenario builder
 */
export class SampleBasedBuilder extends ScenarioBuilder {
  private readonly sampleDir: string;

  constructor(sampleDir: string = '~/.routecodex/codex-samples') {
    super('SampleBased');
    this.sampleDir = sampleDir;
  }

  async buildScenarios(): Promise<TestScenario[]> {
    const scenarios: TestScenario[] = [];
    
    // TODO: Implement sample-based scenario building
    // This will read from ~/.routecodex/codex-samples/
    
    return scenarios;
  }
}

/**
 * Config-based scenario builder
 */
export class ConfigBasedBuilder extends ScenarioBuilder {
  private readonly configDir: string;

  constructor(configDir: string = './config/samples') {
    super('ConfigBased');
    this.configDir = configDir;
  }

  async buildScenarios(): Promise<TestScenario[]> {
    const scenarios: TestScenario[] = [];
    
    // TODO: Implement config-based scenario building
    // This will read from ./config/samples/
    
    return scenarios;
  }
}

/**
 * Dry-run scenario builder
 */
export class DryRunBuilder extends ScenarioBuilder {
  private readonly dryRunDir: string;

  constructor(dryRunDir: string = './config/dry-run') {
    super('DryRun');
    this.dryRunDir = dryRunDir;
  }

  async buildScenarios(): Promise<TestScenario[]> {
    const scenarios: TestScenario[] = [];
    
    // TODO: Implement dry-run scenario building
    // This will read from ./config/dry-run/
    
    return scenarios;
  }
}
