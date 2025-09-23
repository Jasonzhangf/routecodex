/**
 * Environment Configuration
 */

export interface EnvironmentConfig {
  api: {
    baseUrl: string;
    timeout: number;
  };
  websocket: {
    url: string;
    reconnectInterval: number;
    maxReconnectAttempts: number;
  };
  ui: {
    refreshInterval: number;
    maxEvents: number;
    theme: 'light' | 'dark' | 'auto';
  };
}

// Default configuration
export const defaultConfig: EnvironmentConfig = {
  api: {
    baseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:5506',
    timeout: parseInt(import.meta.env.VITE_API_TIMEOUT || '10000'),
  },
  websocket: {
    url: import.meta.env.VITE_WEBSOCKET_URL || 'ws://localhost:5507',
    reconnectInterval: parseInt(import.meta.env.VITE_WEBSOCKET_RECONNECT_INTERVAL || '5000'),
    maxReconnectAttempts: parseInt(import.meta.env.VITE_WEBSOCKET_MAX_RECONNECT_ATTEMPTS || '10'),
  },
  ui: {
    refreshInterval: parseInt(import.meta.env.VITE_UI_REFRESH_INTERVAL || '5000'),
    maxEvents: parseInt(import.meta.env.VITE_UI_MAX_EVENTS || '1000'),
    theme: (import.meta.env.VITE_UI_THEME as 'light' | 'dark' | 'auto') || 'auto',
  },
};

// Development configuration
export const developmentConfig: EnvironmentConfig = {
  ...defaultConfig,
  api: {
    baseUrl: 'http://localhost:5506',
    timeout: 10000,
  },
  websocket: {
    url: 'ws://localhost:5507',
    reconnectInterval: 2000,
    maxReconnectAttempts: 5,
  },
  ui: {
    refreshInterval: 2000,
    maxEvents: 500,
    theme: 'light',
  },
};

// Production configuration
export const productionConfig: EnvironmentConfig = {
  ...defaultConfig,
  api: {
    baseUrl: import.meta.env.VITE_API_BASE_URL || window.location.origin,
    timeout: 30000,
  },
  websocket: {
    url: import.meta.env.VITE_WEBSOCKET_URL || `ws://${window.location.host}`,
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
  },
  ui: {
    refreshInterval: 10000,
    maxEvents: 2000,
    theme: 'auto',
  },
};

// Get current configuration based on environment
export function getConfig(): EnvironmentConfig {
  const isDevelopment = import.meta.env.DEV;

  if (isDevelopment) {
    return developmentConfig;
  }

  return productionConfig;
}