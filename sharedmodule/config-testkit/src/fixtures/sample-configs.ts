/**
 * RouteCodex Test Configuration Samples
 * Real configuration samples for testing
 */

export const SAMPLE_CONFIGS = {
  // Basic valid configuration
  basic: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'openai-provider': {
          id: 'openai-provider',
          type: 'openai',
          enabled: true,
          apiKey: 'sk-test-key',
          models: {
            'gpt-3.5-turbo': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['openai-provider.gpt-3.5-turbo'],
        coding: [],
        longcontext: [],
        tools: [],
        thinking: [],
        vision: [],
        websearch: [],
        background: []
      }
    }
  },

  // Configuration with multiple providers
  multiProvider: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'openai-provider': {
          id: 'openai-provider',
          type: 'openai',
          enabled: true,
          apiKey: 'sk-test-key',
          models: {
            'gpt-3.5-turbo': {
              maxTokens: 4096
            },
            'gpt-4': {
              maxTokens: 8192
            }
          }
        },
        'anthropic-provider': {
          id: 'anthropic-provider',
          type: 'anthropic',
          enabled: true,
          apiKey: 'sk-ant-test-key',
          models: {
            'claude-3-sonnet': {
              maxTokens: 4096
            }
          }
        },
        'lmstudio-provider': {
          id: 'lmstudio-provider',
          type: 'lmstudio',
          enabled: true,
          apiKey: 'lmstudio-key',
          baseURL: 'http://localhost:1234',
          models: {
            'local-model': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['openai-provider.gpt-3.5-turbo'],
        coding: ['openai-provider.gpt-4'],
        longcontext: ['openai-provider.gpt-4'],
        tools: [],
        thinking: ['anthropic-provider.claude-3-sonnet'],
        vision: [],
        websearch: [],
        background: ['lmstudio-provider.local-model']
      }
    }
  },

  // Configuration with environment variables
  withEnvVars: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'env-provider': {
          id: 'env-provider',
          type: 'openai',
          enabled: true,
          apiKey: '${OPENAI_API_KEY}',
          models: {
            'env-model': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['env-provider.env-model'],
        coding: [],
        longcontext: [],
        tools: [],
        thinking: [],
        vision: [],
        websearch: [],
        background: []
      }
    }
  },

  // Configuration with compatibility layers
  withCompatibility: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'lmstudio-provider': {
          id: 'lmstudio-provider',
          type: 'lmstudio',
          enabled: true,
          apiKey: 'lmstudio-key',
          baseURL: 'http://localhost:1234',
          compatibility: {
            type: 'lmstudio-compatibility',
            config: {}
          },
          models: {
            'local-model': {
              maxTokens: 4096
            }
          }
        },
        'qwen-provider': {
          id: 'qwen-provider',
          type: 'qwen',
          enabled: true,
          apiKey: 'qwen-key',
          compatibility: {
            type: 'qwen-compatibility',
            config: {
              toolsEnabled: true
            }
          },
          models: {
            'qwen-model': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['lmstudio-provider.local-model'],
        'qwen-route': ['qwen-provider.qwen-model'],
        coding: [],
        longcontext: [],
        tools: [],
        thinking: [],
        vision: [],
        websearch: [],
        background: []
      }
    }
  },

  // Configuration with OAuth
  withOAuth: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'oauth-provider': {
          id: 'oauth-provider',
          type: 'anthropic',
          enabled: true,
          apiKey: 'dummy-key', // Will be replaced by OAuth
          oauth: {
            'anthropic-oauth': {
              type: 'auth-code',
              clientId: 'test-client-id',
              authUrl: 'https://auth.anthropic.com/auth',
              tokenUrl: 'https://auth.anthropic.com/token',
              scopes: ['read', 'write']
            }
          },
          models: {
            'oauth-model': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['oauth-provider.oauth-model'],
        coding: [],
        longcontext: [],
        tools: [],
        thinking: [],
        vision: [],
        websearch: [],
        background: []
      }
    }
  },

  // Configuration with thinking modes
  withThinking: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'thinking-provider': {
          id: 'thinking-provider',
          type: 'glm',
          enabled: true,
          apiKey: 'glm-key',
          models: {
            'thinking-model': {
              maxTokens: 4096,
              thinking: {
                enabled: true,
                payload: {
                  type: 'enabled'
                }
              }
            },
            'non-thinking-model': {
              maxTokens: 4096,
              thinking: {
                enabled: false
              }
            }
          }
        }
      },
      routing: {
        default: ['thinking-provider.thinking-model'],
        'simple': ['thinking-provider.non-thinking-model'],
        coding: [],
        longcontext: [],
        tools: [],
        thinking: [],
        vision: [],
        websearch: [],
        background: []
      }
    }
  },

  // Invalid configuration for error testing
  invalid: {
    version: '1.0.0',
    port: 'invalid', // Should be number
    virtualrouter: {
      inputProtocol: 'invalid-protocol',
      outputProtocol: 'openai',
      providers: {
        'invalid-provider': {
          type: 'invalid-type',
          enabled: 'true', // Should be boolean
          apiKey: [], // Should be string or array of strings
          models: {} // Should have at least one model
        }
      },
      routing: {
        default: ['invalid-provider.nonexistent-model']
      }
    }
  },

  // Complex configuration with all features
  complex: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'main-provider': {
          type: 'openai',
          enabled: true,
          apiKey: 'sk-test-key',
          compatibility: {
            type: 'field-mapping',
            config: {
              mappings: [
                {
                  from: 'temperature',
                  to: 'temperature',
                  transform: (value: number) => value * 2
                }
              ]
            }
          },
          models: {
            'gpt-3.5-turbo': {
              maxTokens: 4096,
              thinking: {
                enabled: false
              }
            },
            'gpt-4': {
              maxTokens: 8192,
              thinking: {
                enabled: true,
                payload: {
                  type: 'enabled'
                }
              }
            }
          }
        },
        'fallback-provider': {
          type: 'anthropic',
          enabled: true,
          apiKey: 'sk-ant-test-key',
          oauth: {
            'anthropic-oauth': {
              type: 'auth-code',
              clientId: 'test-client-id',
              authUrl: 'https://auth.anthropic.com/auth',
              tokenUrl: 'https://auth.anthropic.com/token',
              scopes: ['read', 'write']
            }
          },
          models: {
            'claude-3-sonnet': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['main-provider.gpt-3.5-turbo'],
        'complex': ['main-provider.gpt-4'],
        'creative': ['fallback-provider.claude-3-sonnet'],
        'fallback': ['main-provider.gpt-3.5-turbo', 'fallback-provider.claude-3-sonnet']
      }
    },
    pipeline: {
      modules: [
        {
          name: 'logging',
          enabled: true,
          config: {
            level: 'debug',
            outputs: ['console', 'file']
          }
        },
        {
          name: 'metrics',
          enabled: true,
          config: {
            endpoint: 'http://localhost:9090'
          }
        },
        {
          name: 'caching',
          enabled: false,
          config: {
            ttl: 3600
          }
        }
      ]
    }
  },

  // GLM provider configuration (from existing configs)
  glmConfig: {
    version: "1.0.0",
    port: 5507,
    virtualrouter: {
      inputProtocol: "openai",
      outputProtocol: "openai",
      providers: {
        "glm-provider": {
          id: "glm-provider",
          type: "openai",
          enabled: true,
          apiKey: "6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB",
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
          compatibility: {
            type: "glm-compatibility",
            config: {
              thinking: {
                enabled: true,
                payload: {
                  type: "enabled"
                }
              }
            }
          },
          models: {
            "glm-4": {
              maxTokens: 8192
            },
            "glm-4.5": {
              maxTokens: 8192,
              thinking: {
                enabled: true
              }
            },
            "glm-4-air": {
              maxTokens: 8192
            },
            "glm-4-airx": {
              maxTokens: 8192
            },
            "glm-4-flash": {
              maxTokens: 8192
            }
          }
        }
      },
      routing: {
        "default": [
          "glm-provider.glm-4.5"
        ],
        "coding": [
          "glm-provider.glm-4.5"
        ],
        "longcontext": [
          "glm-provider.glm-4.5"
        ],
        "tools": [
          "glm-provider.glm-4.5"
        ],
        "thinking": [],
        "vision": [],
        "websearch": [],
        "background": []
      }
    }
  },

  // ModelScope configuration (from existing configs)
  modelscopeConfig: {
    "version": "1.0.0",
    "port": 5508,
    "virtualrouter": {
      "inputProtocol": "openai",
      "outputProtocol": "openai",
      "providers": {
        "modelscope-provider": {
          "type": "qwen",
          "enabled": true,
          "apiKey": "sk-dummy-key",
          "baseURL": "http://127.0.0.1:8000/v1",
          "models": {
            "Qwen2.5-Coder-32B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-7B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-72B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-32B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-14B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-3B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-1.5B-Instruct": {
              "maxTokens": 32768
            },
            "Qwen2.5-0.5B-Instruct": {
              "maxTokens": 32768
            }
          }
        }
      },
      "routing": {
        "default": [
          "modelscope-provider.Qwen2.5-32B-Instruct"
        ],
        "longcontext": [
          "modelscope-provider.Qwen2.5-72B-Instruct"
        ],
        "background": [
          "modelscope-provider.Qwen2.5-1.5B-Instruct"
        ],
        "thinking": [
          "modelscope-provider.Qwen2.5-32B-Instruct"
        ],
        "websearch": [
          "modelscope-provider.Qwen2.5-14B-Instruct"
        ],
        "vision": [
          "modelscope-provider.Qwen2.5-7B-Instruct"
        ],
        "coding": [
          "modelscope-provider.Qwen2.5-Coder-32B-Instruct"
        ]
      }
    }
  }
};

// Test cases for black box testing
export const BLACKBOX_TEST_CASES = [
  {
    id: 'basic-validation',
    name: 'Basic Configuration Validation',
    description: 'Test basic configuration validation',
    inputConfig: SAMPLE_CONFIGS.basic,
    expectedOutput: {
      isValid: true,
      errors: [],
      warnings: [],
      keyAliases: ["key1"],
      normalized: {
        version: '1.0.0',
        port: 8080,
        schemaVersion: '2.0.0',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'openai-provider': {
              id: 'openai-provider',
              type: 'openai-provider',
              enabled: true,
              apiKey: '***REDACTED***',
              compatibility: {
                type: 'passthrough-compatibility',
                config: {}
              },
              keyAliases: ['key1'],
              models: {
                'gpt-3.5-turbo': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            default: ['openai-provider.gpt-3.5-turbo'],
            coding: [],
            longcontext: [],
            tools: [],
            thinking: [],
            vision: [],
            websearch: [],
            background: []
          }
        },
        stableSorting: {
          enabled: true,
          sortKeyMappings: true,
          sortProviders: true,
          sortRouting: true
        }
      }
    }
  },
  {
    id: 'multi-provider-validation',
    name: 'Multi-Provider Configuration Validation',
    description: 'Test configuration with multiple providers',
    inputConfig: SAMPLE_CONFIGS.multiProvider,
    expectedOutput: {
      isValid: true,
      errors: [],
      warnings: [],
      keyAliases: ["key1"],
      normalized: {
        version: '1.0.0',
        port: 8080,
        schemaVersion: '2.0.0',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'openai-provider': {
              id: 'openai-provider',
              type: 'openai-provider',
              enabled: true,
              apiKey: '***REDACTED***',
              compatibility: {
                type: 'passthrough-compatibility',
                config: {}
              },
              keyAliases: ['key1'],
              models: {
                'gpt-3.5-turbo': {
                  maxTokens: 4096
                },
                'gpt-4': {
                  maxTokens: 8192
                }
              }
            },
            'anthropic-provider': {
              id: 'anthropic-provider',
              type: 'anthropic',
              enabled: true,
              apiKey: '***REDACTED***',
              compatibility: {
                type: 'passthrough-compatibility',
                config: {}
              },
              keyAliases: ['key1'],
              models: {
                'claude-3-sonnet': {
                  maxTokens: 4096
                }
              }
            },
            'lmstudio-provider': {
              id: 'lmstudio-provider',
              type: 'lmstudio-http',
              enabled: true,
              apiKey: '***REDACTED***',
              baseURL: 'http://localhost:1234',
              compatibility: {
                type: 'passthrough-compatibility',
                config: {}
              },
              keyAliases: ['key1'],
              models: {
                'local-model': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            default: ['openai-provider.gpt-3.5-turbo'],
            coding: ['openai-provider.gpt-4'],
            longcontext: ['openai-provider.gpt-4'],
            tools: [],
            thinking: ['anthropic-provider.claude-3-sonnet'],
            vision: [],
            websearch: [],
            background: ['lmstudio-provider.local-model']
          }
        },
        stableSorting: {
          enabled: true,
          sortKeyMappings: true,
          sortProviders: true,
          sortRouting: true
        }
      }
    }
  },
  {
    id: 'invalid-config-detection',
    name: 'Invalid Configuration Detection',
    description: 'Test detection of invalid configuration',
    inputConfig: SAMPLE_CONFIGS.invalid,
    expectedOutput: {
      isValid: false,
      errors: [],  // Will contain validation errors
      warnings: []
    }
  }
];

// Test cases for golden snapshot testing
export const GOLDEN_SNAPSHOT_CASES = [
  {
    id: 'basic-config-snapshot',
    name: 'Basic Configuration Snapshot',
    description: 'Golden snapshot for basic configuration',
    inputConfig: SAMPLE_CONFIGS.basic,
    tags: ['basic', 'validation']
  },
  {
    id: 'multi-provider-snapshot',
    name: 'Multi-Provider Configuration Snapshot',
    description: 'Golden snapshot for multi-provider configuration',
    inputConfig: SAMPLE_CONFIGS.multiProvider,
    tags: ['multi-provider', 'routing']
  },
  {
    id: 'complex-config-snapshot',
    name: 'Complex Configuration Snapshot',
    description: 'Golden snapshot for complex configuration',
    inputConfig: SAMPLE_CONFIGS.complex,
    tags: ['complex', 'pipeline']
  }
];

// Performance test cases
export const PERFORMANCE_TEST_CASES = [
  {
    id: 'small-config-perf',
    name: 'Small Configuration Performance',
    description: 'Performance test for small configurations',
    config: SAMPLE_CONFIGS.basic,
    iterations: 1000,
    warmupIterations: 100
  },
  {
    id: 'medium-config-perf',
    name: 'Medium Configuration Performance',
    description: 'Performance test for medium configurations',
    config: SAMPLE_CONFIGS.multiProvider,
    iterations: 500,
    warmupIterations: 50
  },
  {
    id: 'large-config-perf',
    name: 'Large Configuration Performance',
    description: 'Performance test for large configurations',
    config: SAMPLE_CONFIGS.complex,
    iterations: 100,
    warmupIterations: 10
  }
];

// Environment setup for tests
export const TEST_ENVIRONMENTS = {
  development: {
    variables: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug'
    },
    mockServices: {}
  },
  production: {
    variables: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn'
    },
    mockServices: {}
  },
  testing: {
    variables: {
      NODE_ENV: 'testing',
      LOG_LEVEL: 'error'
    },
    mockServices: {}
  }
};