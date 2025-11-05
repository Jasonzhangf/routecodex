/**
 * V2 Configuration Library
 *
 * Centralized configuration management for V2 architecture.
 * Provides configuration validation, transformation, and management.
 */

import type { V2SystemConfig, ModuleConfig, ProviderConfig } from '../types/v2-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { ConfigValidationError } from '../types/v2-types.js';

/**
 * Configuration Template
 */
export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  category: 'provider' | 'compatibility' | 'llmswitch' | 'system';
  version: string;
  template: UnknownObject;
  requiredFields: string[];
  optionalFields: string[];
  validationRules: Array<{
    field: string;
    rule: 'required' | 'type' | 'range' | 'pattern' | 'custom';
    params: UnknownObject;
    message: string;
  }>;
}

/**
 * Configuration Library
 *
 * Manages all V2 configurations with validation and templates.
 */
export class V2ConfigLibrary {
  private static instance: V2ConfigLibrary;
  private readonly templates = new Map<string, ConfigTemplate>();
  private readonly configurations = new Map<string, ModuleConfig>();
  private readonly defaults = new Map<string, UnknownObject>();

  private constructor() {
    this.initializeDefaultTemplates();
    this.initializeDefaultConfigurations();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): V2ConfigLibrary {
    if (!V2ConfigLibrary.instance) {
      V2ConfigLibrary.instance = new V2ConfigLibrary();
    }
    return V2ConfigLibrary.instance;
  }

  /**
   * Register configuration template
   */
  registerTemplate(template: ConfigTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * Get configuration template
   */
  getTemplate(templateId: string): ConfigTemplate | null {
    return this.templates.get(templateId) || null;
  }

  /**
   * List all templates
   */
  listTemplates(): ConfigTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Register module configuration
   */
  registerConfiguration(configId: string, config: ModuleConfig): void {
    // Validate configuration against template if available
    const template = this.getTemplate(config.type);
    if (template) {
      const validation = this.validateConfiguration(config, template);
      if (!validation.isValid) {
        throw new ConfigValidationError(
          `Configuration validation failed: ${validation.errors.join(', ')}`,
          ['config', configId]
        );
      }
    }

    this.configurations.set(configId, config);
  }

  /**
   * Get module configuration
   */
  getConfiguration(configId: string): ModuleConfig | null {
    return this.configurations.get(configId) || null;
  }

  /**
   * List all configurations
   */
  listConfigurations(): Record<string, ModuleConfig> {
    const result: Record<string, ModuleConfig> = {};
    for (const [id, config] of this.configurations) {
      result[id] = { ...config };
    }
    return result;
  }

  /**
   * Register default configuration
   */
  registerDefault(configId: string, defaults: UnknownObject): void {
    this.defaults.set(configId, defaults);
  }

  /**
   * Get default configuration
   */
  getDefault(configId: string): UnknownObject | null {
    return this.defaults.get(configId) || null;
  }

  /**
   * Create configuration from template
   */
  createConfigurationFromTemplate(
    templateId: string,
    configId: string,
    overrides: UnknownObject = {}
  ): ModuleConfig {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new ConfigValidationError(
        `Template not found: ${templateId}`,
        ['template', templateId]
      );
    }

    // Start with defaults
    const defaults = this.getDefault(templateId) || {};
    const config = { ...defaults, ...template.template, ...overrides };

    // Validate required fields
    for (const field of template.requiredFields) {
      if (!(field in config)) {
        throw new ConfigValidationError(
          `Required field missing: ${field}`,
          ['config', configId, 'field', field]
        );
      }
    }

    const moduleConfig: ModuleConfig = {
      type: templateId,
      config
    };

    // Register the configuration
    this.registerConfiguration(configId, moduleConfig);

    return moduleConfig;
  }

  /**
   * Validate configuration against template
   */
  validateConfiguration(config: ModuleConfig, template: ConfigTemplate): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const rule of template.validationRules) {
      const value = this.extractFieldValue(config.config, rule.field);

      switch (rule.rule) {
        case 'required':
          if (value === undefined || value === null || value === '') {
            errors.push(rule.message);
          }
          break;

        case 'type': {
          const expectedType = rule.params.type as string;
          const actualType = typeof value;
          if (actualType !== expectedType) {
            errors.push(`${rule.message} (expected ${expectedType}, got ${actualType})`);
          }
          break;
        }

        case 'range':
          if (typeof value === 'number') {
            const min = rule.params.min as number;
            const max = rule.params.max as number;
            if (value < min || value > max) {
              errors.push(`${rule.message} (must be between ${min} and ${max})`);
            }
          }
          break;

        case 'pattern':
          if (typeof value === 'string') {
            const pattern = new RegExp(rule.params.pattern as string);
            if (!pattern.test(value)) {
              errors.push(rule.message);
            }
          }
          break;

        case 'custom':
          // Custom validation function would be called here
          // For now, just log that custom validation was attempted
          warnings.push(`Custom validation for ${rule.field} not implemented`);
          break;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Transform V1 configuration to V2
   */
  transformV1ToV2(v1Config: UnknownObject): V2SystemConfig {
    // Basic V1 to V2 transformation
    const v2Config: V2SystemConfig = {
      version: '2.0',
      system: {
        mode: 'hybrid',
        enableDryRun: false,
        featureFlags: {
          enableV2Routing: true,
          enableValidation: true,
          enableMetrics: true
        }
      },
      staticInstances: {
        // Preload default modules to ensure V2 shadow pipeline can resolve
        // provider/compatibility/llmswitch instances without dynamic creation.
        // This avoids runtime "Instance not found" errors in dry-run mode.
        preloadModules: ['provider-default', 'compatibility-default', 'llmswitch-default'],
        poolConfig: {
          maxInstancesPerType: 5,
          warmupInstances: 2,
          idleTimeout: 300000
        }
      },
      virtualPipelines: {
        routeTable: {
          routes: [],
          defaultRoute: 'default'
        },
        moduleRegistry: {
          providers: {},
          compatibility: {},
          llmSwitch: {}
        }
      },
      legacy: v1Config
    };

    // Extract provider configurations from V1 config
    if (v1Config.providers) {
      for (const [providerId, providerConfig] of Object.entries(v1Config.providers as UnknownObject)) {
        v2Config.virtualPipelines.moduleRegistry.providers[providerId] = {
          type: 'custom',
          config: this.transformProviderConfig(providerConfig as UnknownObject)
        };
      }
    }

    // Create default route
    v2Config.virtualPipelines.routeTable.routes.push({
      id: 'default',
      pattern: {},
      modules: [
        { type: 'provider-default' },
        { type: 'compatibility-default' },
        { type: 'llmswitch-default' }
      ],
      priority: 0
    });

    // Ensure default module registry entries exist for the default route.
    // We pick reasonable defaults derived from V1 providers when available.
    // - provider-default: first provider in v1Config.providers or OpenAI placeholder
    // - compatibility-default: OpenAI compatibility by default (no-op mapping)
    // - llmswitch-default: standard anthropic-to-openai conversion profile

    // Provider default: choose the first configured provider as baseline
    const firstV1ProviderId = v1Config && typeof v1Config === 'object' && (v1Config as any).providers
      ? Object.keys((v1Config as any).providers as Record<string, unknown>)[0]
      : null;

    if (firstV1ProviderId) {
      const src = (v1Config as any).providers[firstV1ProviderId] as UnknownObject;
      v2Config.virtualPipelines.moduleRegistry.providers['provider-default'] = {
        type: 'provider',
        config: this.transformProviderConfig(src)
      };
    } else {
      // Fallback default provider shape (will still require valid env to actually call)
      v2Config.virtualPipelines.moduleRegistry.providers['provider-default'] = {
        type: 'provider',
        config: {
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          auth: { type: 'apikey' }
        }
      } as ProviderConfig;
    }

    // Compatibility default: OpenAI-compatible passthrough mapping
    v2Config.virtualPipelines.moduleRegistry.compatibility['compatibility-default'] = {
      type: 'compatibility',
      config: {
        providerType: 'openai',
        fieldMappings: {
          request: { model: 'model', messages: 'messages', temperature: 'temperature' },
          response: { choices: 'choices', usage: 'usage' }
        },
        formatConversions: {},
        providerSpecificProcessing: { cleanup: [], conversions: [] }
      }
    };

    // LLM Switch default: standard conversion profile
    v2Config.virtualPipelines.moduleRegistry.llmSwitch['llmswitch-default'] = {
      type: 'llmswitch',
      config: {
        conversionType: 'anthropic-to-openai',
        protocol: 'openai',
        profile: {}
      }
    };

    return v2Config;
  }

  /**
   * Get configuration summary
   */
  getConfigurationSummary(): {
    templates: number;
    configurations: number;
    defaults: number;
    categories: Record<string, number>;
  } {
    const categories: Record<string, number> = {};
    for (const template of this.templates.values()) {
      categories[template.category] = (categories[template.category] || 0) + 1;
    }

    return {
      templates: this.templates.size,
      configurations: this.configurations.size,
      defaults: this.defaults.size,
      categories
    };
  }

  /**
   * Export configuration library
   */
  exportLibrary(): {
    templates: Record<string, ConfigTemplate>;
    configurations: Record<string, ModuleConfig>;
    defaults: Record<string, UnknownObject>;
  } {
    const templates: Record<string, ConfigTemplate> = {};
    const configurations: Record<string, ModuleConfig> = {};
    const defaults: Record<string, UnknownObject> = {};

    for (const [id, template] of this.templates) {
      templates[id] = template;
    }

    for (const [id, config] of this.configurations) {
      configurations[id] = config;
    }

    for (const [id, defaults] of this.defaults) {
      defaults[id] = defaults;
    }

    return { templates, configurations, defaults };
  }

  /**
   * Import configuration library
   */
  importLibrary(data: {
    templates: Record<string, ConfigTemplate>;
    configurations: Record<string, ModuleConfig>;
    defaults: Record<string, UnknownObject>;
  }): void {
    // Clear existing data
    this.templates.clear();
    this.configurations.clear();
    this.defaults.clear();

    // Import templates
    for (const [id, template] of Object.entries(data.templates)) {
      this.templates.set(id, template);
    }

    // Import configurations
    for (const [id, config] of Object.entries(data.configurations)) {
      this.configurations.set(id, config);
    }

    // Import defaults
    for (const [id, defaults] of Object.entries(data.defaults)) {
      this.defaults.set(id, defaults);
    }
  }

  /**
   * Initialize default templates
   */
  private initializeDefaultTemplates(): void {
    // Provider template
    this.registerTemplate({
      id: 'provider-openai',
      name: 'OpenAI Provider',
      description: 'OpenAI-compatible provider configuration',
      category: 'provider',
      version: '1.0',
      template: {
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        auth: {
          type: 'apikey',
          apiKey: ''
        },
        timeout: 30000,
        maxRetries: 3,
        overrides: {
          defaultModel: 'gpt-3.5-turbo'
        }
      },
      requiredFields: ['providerType', 'baseUrl', 'auth.apiKey'],
      optionalFields: ['timeout', 'maxRetries', 'overrides'],
      validationRules: [
        {
          field: 'providerType',
          rule: 'required',
          params: {},
          message: 'Provider type is required'
        },
        {
          field: 'baseUrl',
          rule: 'pattern',
          params: { pattern: '^https?://.+' },
          message: 'Base URL must be a valid HTTP/HTTPS URL'
        },
        {
          field: 'auth.apiKey',
          rule: 'required',
          params: {},
          message: 'API key is required'
        },
        {
          field: 'timeout',
          rule: 'range',
          params: { min: 1000, max: 300000 },
          message: 'Timeout must be between 1000ms and 300000ms'
        }
      ]
    });

    // Compatibility template
    this.registerTemplate({
      id: 'compatibility-glm',
      name: 'GLM Compatibility',
      description: 'GLM provider compatibility configuration',
      category: 'compatibility',
      version: '1.0',
      template: {
        providerType: 'glm',
        fieldMappings: {
          request: {
            'model': 'model',
            'messages': 'messages',
            'temperature': 'temperature'
          },
          response: {
            'choices': 'choices',
            'usage': 'usage'
          }
        },
        formatConversions: {},
        providerSpecificProcessing: {
          cleanup: [],
          conversions: []
        }
      },
      requiredFields: ['providerType', 'fieldMappings'],
      optionalFields: ['formatConversions', 'providerSpecificProcessing'],
      validationRules: [
        {
          field: 'providerType',
          rule: 'required',
          params: {},
          message: 'Provider type is required'
        },
        {
          field: 'fieldMappings',
          rule: 'required',
          params: {},
          message: 'Field mappings are required'
        }
      ]
    });

    // LLM Switch template
    this.registerTemplate({
      id: 'llmswitch-core',
      name: 'LLM Switch Core',
      description: 'Core LLM switch configuration',
      category: 'llmswitch',
      version: '1.0',
      template: {
        conversionType: 'anthropic-to-openai',
        protocol: 'openai',
        profile: {}
      },
      requiredFields: ['conversionType', 'protocol'],
      optionalFields: ['profile'],
      validationRules: [
        {
          field: 'conversionType',
          rule: 'required',
          params: {},
          message: 'Conversion type is required'
        },
        {
          field: 'protocol',
          rule: 'required',
          params: {},
          message: 'Protocol is required'
        }
      ]
    });
  }

  /**
   * Initialize default configurations
   */
  private initializeDefaultConfigurations(): void {
    // Register default values for templates
    this.registerDefault('provider-openai', {
      timeout: 30000,
      maxRetries: 3,
      overrides: {
        defaultModel: 'gpt-3.5-turbo',
        headers: {}
      },
      validation: {
        requiredEnvVars: ['OPENAI_API_KEY'],
        validateAtRuntime: true
      }
    });

    this.registerDefault('compatibility-glm', {
      formatConversions: {
        timestamp: {
          source: 'created',
          target: 'created',
          transform: 'dateToString'
        }
      },
      providerSpecificProcessing: {
        cleanup: [
          { field: 'id', action: 'remove' }
        ]
      }
    });

    this.registerDefault('llmswitch-core', {
      profile: {
        enableTools: true,
        enableStreaming: true
      }
    });
  }

  /**
   * Extract field value from nested object
   */
  private extractFieldValue(obj: UnknownObject, fieldPath: string): unknown {
    const parts = fieldPath.split('.');
    let current = obj;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = (current as Record<string, unknown>)[part] as UnknownObject;
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Transform provider configuration from V1 to V2
   */
  private transformProviderConfig(v1ProviderConfig: UnknownObject): ProviderConfig['config'] {
    const config = v1ProviderConfig as Record<string, unknown>;
    const auth = config.auth as Record<string, unknown> | undefined;

    return {
      providerType: (config.type as string) || 'custom',
      baseUrl: config.baseUrl as string,
      auth: {
        type: ((auth?.type as string) as 'apikey' | 'oauth') || 'apikey',
        apiKey: auth?.apiKey as string,
        clientId: auth?.clientId as string,
        clientSecret: auth?.clientSecret as string,
        tokenUrl: auth?.tokenUrl as string
      },
      timeout: (config.timeout as number) || 30000,
      maxRetries: (config.maxRetries as number) || 3,
      overrides: config.overrides as UnknownObject,
      validation: config.validation as UnknownObject
    };
  }
}

/**
 * Validation Result
 */
interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}
