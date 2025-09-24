#!/usr/bin/env node

import { UserConfigParser } from './src/config/user-config-parser.js';

// 测试用例1：单个key的provider
const singleKeyConfig = {
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {
      'openai': {
        type: 'openai',
        baseURL: 'https://api.openai.com',
        apiKey: ['sk-single-key'],
        models: {
          'gpt-3.5-turbo': {
            maxContext: 4096,
            maxTokens: 2048
          }
        }
      }
    },
    routing: {
      'default': ['openai.gpt-3.5-turbo']
    }
  }
};

// 测试用例2：多个key的provider
const multiKeyConfig = {
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {
      'openai': {
        type: 'openai',
        baseURL: 'https://api.openai.com',
        apiKey: ['sk-key-1', 'sk-key-2', 'sk-key-3'],
        models: {
          'gpt-3.5-turbo': {
            maxContext: 4096,
            maxTokens: 2048
          }
        }
      }
    },
    routing: {
      'default': ['openai.gpt-3.5-turbo']
    }
  }
};

// 测试用例3：指定特定key
const specificKeyConfig = {
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {
      'openai': {
        type: 'openai',
        baseURL: 'https://api.openai.com',
        apiKey: ['sk-key-1', 'sk-key-2', 'sk-key-3'],
        models: {
          'gpt-3.5-turbo': {
            maxContext: 4096,
            maxTokens: 2048
          }
        }
      }
    },
    routing: {
      'default': ['openai.gpt-3.5-turbo.sk-key-2']
    }
  }
};

function testConfig(config, testName) {
  console.log(`\n=== ${testName} ===`);
  
  try {
    const parser = new UserConfigParser();
    const result = parser.parseUserConfig(config);
    
    console.log('路由目标:');
    for (const [routeName, targets] of Object.entries(result.routeTargets)) {
      console.log(`  ${routeName}:`);
      targets.forEach(target => {
        console.log(`    - ${target.providerId}.${target.modelId}.${target.keyId} (actualKey: ${target.actualKey})`);
      });
    }
    
    console.log('流水线配置:');
    for (const [configKey, config] of Object.entries(result.pipelineConfigs)) {
      console.log(`  ${configKey}:`);
      console.log(`    keyConfig:`, config.keyConfig);
    }
    
  } catch (error) {
    console.error('错误:', error.message);
  }
}

// 运行测试
testConfig(singleKeyConfig, '单个key场景');
testConfig(multiKeyConfig, '多个key场景');
testConfig(specificKeyConfig, '指定特定key场景');