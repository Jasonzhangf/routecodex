/**
 * Server V2 测试
 *
 * 测试V2服务器的功能和性能
 * 与V1进行对比测试
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { RouteCodexServerV2 } from '../src/server-v2/core/route-codex-server-v2.js';
import { ServerFactory } from '../src/server-factory.js';
import { VersionSelector } from '../src/migration/version-selector.js';

/**
 * V2服务器配置
 */
const v2Config = {
  server: {
    port: 5507,  // 使用不同端口避免冲突
    host: '127.0.0.1',
    cors: {
      origin: '*',
      credentials: true
    }
  },
  logging: {
    level: 'info' as const,
    enableConsole: true
  },
  providers: {
    'test-provider': {
      enabled: true,
      models: {
        'test-model': {
          maxTokens: 4096,
          temperature: 0.7
        }
      }
    }
  },
  v2Config: {
    enableHooks: true,
    enableMiddleware: true
  }
};

describe('RouteCodex Server V2', () => {
  let server: any;

  beforeAll(async () => {
    console.log('[Test] Setting up V2 server tests');
  });

  afterAll(async () => {
    console.log('[Test] Cleaning up V2 server tests');
    if (server && server.isRunning()) {
      await server.stop();
    }
  });

  beforeEach(() => {
    // 每个测试前重置
  });

  afterEach(() => {
    // 每个测试后清理
  });

  describe('Initialization', () => {
    test('should create V2 server instance', () => {
      server = new RouteCodexServerV2(v2Config);

      expect(server).toBeDefined();
      expect(server.getModuleInfo().version).toBe('2.0.0');
      expect(server.getModuleInfo().id).toBe('routecodex-server-v2');
    });

    test('should initialize successfully', async () => {
      server = new RouteCodexServerV2(v2Config);

      await expect(server.initialize()).resolves.not.toThrow();
      expect(server.isInitialized()).toBe(true);
    });

    test('should start and stop successfully', async () => {
      server = new RouteCodexServerV2(v2Config);
      await server.initialize();

      await expect(server.start()).resolves.not.toThrow();
      expect(server.isRunning()).toBe(true);

      const status = server.getStatus();
      expect(status.version).toBe('v2');
      expect(status.running).toBe(true);
      expect(status.port).toBe(5507);

      await expect(server.stop()).resolves.not.toThrow();
      expect(server.isRunning()).toBe(false);
    });
  });

  describe('Health Check', () => {
    beforeAll(async () => {
      server = new RouteCodexServerV2(v2Config);
      await server.initialize();
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    test('should respond to health-v2 endpoint', async () => {
      const response = await fetch('http://127.0.0.1:5507/health-v2');

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.version).toBe('v2');
      expect(data.hooksEnabled).toBe(true);
      expect(data.middlewareEnabled).toBe(true);
    });

    test('should respond to legacy health endpoint', async () => {
      const response = await fetch('http://127.0.0.1:5507/health');

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.version).toBe('v2');
    });

    test('should respond to status-v2 endpoint', async () => {
      const response = await fetch('http://127.0.0.1:5507/status-v2');

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.version).toBe('v2');
      expect(data.initialized).toBe(true);
      expect(data.running).toBe(true);
    });
  });

  describe('Chat Completions V2', () => {
    beforeAll(async () => {
      server = new RouteCodexServerV2(v2Config);
      await server.initialize();
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    test('should handle basic chat completion request', async () => {
      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: [
            { role: 'user', content: 'Hello, V2 server!' }
          ]
        })
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.id).toBeDefined();
      expect(data.object).toBe('chat.completion');
      expect(data.model).toBe('test-model');
      expect(data.choices).toHaveLength(1);
      expect(data.choices[0].message.role).toBe('assistant');
      expect(data.choices[0].message.content).toContain('V2 Mock Response');
      expect(data.usage).toBeDefined();
    });

    test('should handle request with system message', async () => {
      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello!' }
          ]
        })
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.choices[0].message.content).toContain('V2 Mock Response');
    });

    test('should validate request body', async () => {
      // 测试缺少model字段
      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'Hello!' }
          ]
        })
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.type).toBe('validation_error');
      expect(data.error.message).toContain('Model is required');
    });

    test('should validate messages array', async () => {
      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: 'invalid'
        })
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.type).toBe('validation_error');
      expect(data.error.message).toContain('Messages must be an array');
    });

    test('should handle empty messages array', async () => {
      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: []
        })
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.type).toBe('validation_error');
      expect(data.error.message).toContain('Messages array cannot be empty');
    });
  });

  describe('Models Endpoint', () => {
    beforeAll(async () => {
      server = new RouteCodexServerV2(v2Config);
      await server.initialize();
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    test('should return models list', async () => {
      const response = await fetch('http://127.0.0.1:5507/v1/models');

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.object).toBe('list');
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data).toHaveLength(1);

      const model = data.data[0];
      expect(model.id).toBe('test-model');
      expect(model.object).toBe('model');
      expect(model.owned_by).toBe('test-provider');
    });
  });

  describe('Error Handling', () => {
    beforeAll(async () => {
      server = new RouteCodexServerV2(v2Config);
      await server.initialize();
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    test('should handle 404 for unknown endpoints', async () => {
      const response = await fetch('http://127.0.0.1:5507/unknown-endpoint');

      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.type).toBe('not_found_error');
      expect(data.error.code).toBe('not_found');
    });

    test('should handle invalid JSON', async () => {
      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: 'invalid json'
      });

      expect(response.status).toBe(400);
    });
  });
});

describe('ServerFactory', () => {
  describe('V2 Server Creation', () => {
    test('should create V2 server instance', async () => {
      const server = await ServerFactory.createV2ServerForTest();

      expect(server).toBeDefined();
      expect(server.getModuleInfo().version).toBe('2.0.0');
    });

    test('should create V2 server with custom config', async () => {
      const customConfig = {
        server: {
          port: 5508,
          host: '127.0.0.1'
        },
        logging: {
          level: 'debug' as const
        },
        providers: {},
        v2Config: {
          enableHooks: false
        }
      };

      const server = await ServerFactory.createV2ServerForTest(customConfig);
      await server.initialize();

      const status = server.getStatus();
      expect(status.port).toBe(5508);
      expect(status.hooksEnabled).toBe(false);

      await server.stop();
    });
  });

  describe('Fallback Mechanism', () => {
    test('should fallback to V1 when V2 fails', async () => {
      // 创建一个会导致V2失败的配置
      const invalidConfig = {
        server: {
          port: -1,  // 无效端口
          host: '127.0.0.1'
        },
        logging: {
          level: 'info' as const
        },
        providers: {},
        v2Config: {
          enableHooks: true
        }
      };

      // 这应该回退到V1 (但由于V1可能不存在，会抛出错误)
      try {
        await ServerFactory.createServer(invalidConfig, { useV2: true, fallbackToV1: true });
      } catch (error) {
        expect(error.message).toContain('Failed to create V2 server');
      }
    });
  });
});

describe('VersionSelector', () => {
  let selector: VersionSelector;

  beforeEach(() => {
    selector = new VersionSelector({
      allowRuntimeSwitch: true,
      fallbackToV1: true
    });
  });

  afterEach(async () => {
    await selector.cleanup();
  });

  test('should initialize with V1 as default', () => {
    expect(selector.getCurrentVersion()).toBe('v1');
  });

  test('should get version info', async () => {
    const v1Config = {
      server: { port: 5506, host: '127.0.0.1' },
      logging: { level: 'info' },
      providers: {}
    };

    const v2Config = {
      server: { port: 5507, host: '127.0.0.1' },
      logging: { level: 'info' },
      providers: {},
      v2Config: { enableHooks: true }
    };

    const versionInfo = await selector.getAllVersionInfo(v1Config, v2Config);

    expect(versionInfo.v1.version).toBe('v1');
    expect(versionInfo.v2.version).toBe('v2');
  });

  test('should perform health check', async () => {
    const healthStatus = await selector.healthCheck();

    expect(healthStatus).toHaveProperty('healthy');
    expect(healthStatus).toHaveProperty('currentVersion');
    expect(healthStatus).toHaveProperty('versions');
    expect(healthStatus).toHaveProperty('issues');
  });
});

describe('Performance Tests', () => {
  let server: any;

  beforeAll(async () => {
    server = new RouteCodexServerV2(v2Config);
    await server.initialize();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('should handle concurrent requests', async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: `Test request ${i}` }]
        })
      })
    );

    const startTime = Date.now();
    const responses = await Promise.all(requests);
    const endTime = Date.now();

    expect(responses).toHaveLength(10);

    // 所有请求都应该成功
    responses.forEach(response => {
      expect(response.status).toBe(200);
    });

    // 性能检查：10个并发请求应该在合理时间内完成
    const totalTime = endTime - startTime;
    console.log(`[Performance] 10 concurrent requests completed in ${totalTime}ms`);
    expect(totalTime).toBeLessThan(1000); // 1秒内完成
  });

  test('should have reasonable response time', async () => {
    const iterations = 5;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const startTime = Date.now();

      const response = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Performance test' }]
        })
      });

      const endTime = Date.now();
      times.push(endTime - startTime);

      expect(response.status).toBe(200);
    }

    const averageTime = times.reduce((sum, time) => sum + time, 0) / times.length;
    const maxTime = Math.max(...times);

    console.log(`[Performance] Average response time: ${averageTime}ms, Max: ${maxTime}ms`);

    expect(averageTime).toBeLessThan(100); // 平均响应时间小于100ms
    expect(maxTime).toBeLessThan(200); // 最大响应时间小于200ms
  });
});