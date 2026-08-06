/**
 * WASM Runtime Module
 *
 * WASM-backed runtime implementation for llmswitch-core integration.
 * Provides shadow/primary dual-loading, priority matrix, and switch capabilities.
 */

export type WasmRuntimeMode = 'shadow' | 'primary' | 'split';

export interface WasmRuntimeConfig {
  mode: WasmRuntimeMode;
  wasmPath?: string;
  fallbackOnError?: boolean;
  shadowTimeoutMs?: number;
}

export interface WasmRuntimeMetrics {
  requestsTotal: number;
  requestsShadow: number;
  errorsTotal: number;
  shadowLatencyMs: number;
  lastError?: string;
}

/**
 * WASM Runtime instance interface
 */
export interface WasmRuntime {
  readonly mode: WasmRuntimeMode;
  readonly isReady: boolean;
  readonly metrics: WasmRuntimeMetrics;

  /**
   * Initialize the WASM runtime
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the WASM runtime
   */
  shutdown(): Promise<void>;
}

/**
 * WASM Runtime factory options
 */
export interface WasmRuntimeFactoryOptions {
  config: WasmRuntimeConfig;
  onError?: (error: Error) => void;
  onMetricsUpdate?: (metrics: WasmRuntimeMetrics) => void;
}

/**
 * Create a new WASM runtime instance
 */
export function createWasmRuntime(options: WasmRuntimeFactoryOptions): WasmRuntime {
  return new WasmRuntimeImpl(options);
}

/**
 * Default WASM runtime configuration
 */
export function getDefaultWasmRuntimeConfig(): WasmRuntimeConfig {
  return {
    mode: 'primary',
    fallbackOnError: true,
    shadowTimeoutMs: 5000
  };
}

/**
 * Resolve WASM runtime mode from environment
 */
export function resolveWasmRuntimeModeFromEnv(): WasmRuntimeMode {
  const impl = process.env.ROUTECODEX_HUB_PIPELINE_IMPL || 'ts';
  switch (impl) {
    case 'wasm':
      return 'primary';
    case 'shadow':
      return 'shadow';
    case 'split':
      return 'split';
    default:
      return 'primary';
  }
}

// Internal implementation placeholder
class WasmRuntimeImpl implements WasmRuntime {
  readonly mode: WasmRuntimeMode;
  private _isReady = false;
  private _metrics: WasmRuntimeMetrics;
  private readonly _options: WasmRuntimeFactoryOptions;

  constructor(options: WasmRuntimeFactoryOptions) {
    this.mode = options.config.mode;
    this._options = options;
    this._metrics = {
      requestsTotal: 0,
      requestsShadow: 0,
      errorsTotal: 0,
      shadowLatencyMs: 0
    };
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get metrics(): WasmRuntimeMetrics {
    return { ...this._metrics };
  }

  async initialize(): Promise<void> {
    // Placeholder: actual WASM initialization to be implemented in follow-up tasks
    this._isReady = true;
  }

  async shutdown(): Promise<void> {
    this._isReady = false;
  }
}
