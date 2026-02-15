/**
 * WASM Runtime unit tests
 */

import {
  createWasmRuntime,
  getDefaultWasmRuntimeConfig,
  resolveWasmRuntimeModeFromEnv,
  type WasmRuntimeConfig
} from '../../../src/runtime/wasm-runtime/index.js';

describe('WasmRuntime', () => {
  describe('createWasmRuntime', () => {
    it('should create a runtime with default config', () => {
      const config: WasmRuntimeConfig = getDefaultWasmRuntimeConfig();
      const runtime = createWasmRuntime({ config });
      
      expect(runtime.mode).toBe('primary');
      expect(runtime.isReady).toBe(false);
      expect(runtime.metrics.requestsTotal).toBe(0);
    });

    it('should create a runtime in shadow mode', () => {
      const config: WasmRuntimeConfig = {
        mode: 'shadow',
        fallbackOnError: true,
        shadowTimeoutMs: 3000
      };
      const runtime = createWasmRuntime({ config });
      
      expect(runtime.mode).toBe('shadow');
    });

    it('should initialize and shutdown correctly', async () => {
      const config = getDefaultWasmRuntimeConfig();
      const runtime = createWasmRuntime({ config });
      
      expect(runtime.isReady).toBe(false);
      
      await runtime.initialize();
      expect(runtime.isReady).toBe(true);
      
      await runtime.shutdown();
      expect(runtime.isReady).toBe(false);
    });
  });

  describe('resolveWasmRuntimeModeFromEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('should return primary when ROUTECODEX_HUB_PIPELINE_IMPL is not set', () => {
      delete process.env.ROUTECODEX_HUB_PIPELINE_IMPL;
      expect(resolveWasmRuntimeModeFromEnv()).toBe('primary');
    });

    it('should return primary for ts impl', () => {
      process.env.ROUTECODEX_HUB_PIPELINE_IMPL = 'ts';
      expect(resolveWasmRuntimeModeFromEnv()).toBe('primary');
    });

    it('should return primary for wasm impl', () => {
      process.env.ROUTECODEX_HUB_PIPELINE_IMPL = 'wasm';
      expect(resolveWasmRuntimeModeFromEnv()).toBe('primary');
    });

    it('should return shadow for shadow impl', () => {
      process.env.ROUTECODEX_HUB_PIPELINE_IMPL = 'shadow';
      expect(resolveWasmRuntimeModeFromEnv()).toBe('shadow');
    });

    it('should return split for split impl', () => {
      process.env.ROUTECODEX_HUB_PIPELINE_IMPL = 'split';
      expect(resolveWasmRuntimeModeFromEnv()).toBe('split');
    });
  });
});
