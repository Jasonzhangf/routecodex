/**
 * Custom hook for API calls
 */

import { useState, useEffect, useCallback } from 'react';
import { debugApi } from '../services/api';

interface UseApiOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export function useApi<T>(
  apiCall: () => Promise<T>,
  options: UseApiOptions = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiCall();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [apiCall]);

  useEffect(() => {
    fetchData();

    if (options.autoRefresh && options.refreshInterval) {
      const interval = setInterval(fetchData, options.refreshInterval);
      return () => clearInterval(interval);
    }
  }, [fetchData, options.autoRefresh, options.refreshInterval]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}

// Specific hooks for common API calls
export function useSystemHealth(options: UseApiOptions = {}) {
  return useApi(() => debugApi.getSystemHealth(), {
    autoRefresh: true,
    refreshInterval: 30000, // 30 seconds
    ...options,
  });
}

export function useModuleStatuses(options: UseApiOptions = {}) {
  return useApi(() => debugApi.getModuleStatuses(), {
    autoRefresh: true,
    refreshInterval: 10000, // 10 seconds
    ...options,
  });
}

export function useModuleDetails(moduleId: string, options: UseApiOptions = {}) {
  return useApi(() => debugApi.getModuleDetails(moduleId), {
    autoRefresh: true,
    refreshInterval: 5000, // 5 seconds
    ...options,
  });
}

export function useEvents(
  filters?: {
    type?: string;
    moduleId?: string;
    limit?: number;
    offset?: number;
    startTime?: number;
    endTime?: number;
  },
  options: UseApiOptions = {}
) {
  return useApi(() => debugApi.getEvents(filters), {
    autoRefresh: true,
    refreshInterval: 5000, // 5 seconds
    ...options,
  });
}

export function usePerformanceMetrics(
  timeRange?: { start: number; end: number },
  options: UseApiOptions = {}
) {
  return useApi(() => debugApi.getPerformanceMetrics(timeRange), {
    autoRefresh: true,
    refreshInterval: 10000, // 10 seconds
    ...options,
  });
}

// Hook for module configuration updates
export function useModuleConfig() {
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateConfig = useCallback(async (moduleId: string, config: Record<string, any>) => {
    try {
      setUpdating(true);
      setError(null);
      await debugApi.updateModuleConfig(moduleId, config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setUpdating(false);
    }
  }, []);

  return {
    updateConfig,
    updating,
    error,
  };
}

// Hook for data export
export function useDataExport() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportData = useCallback(async (format: 'json' | 'csv' = 'json') => {
    try {
      setExporting(true);
      setError(null);
      const blob = await debugApi.exportDebugData(format);

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `routecodex-debug-${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setExporting(false);
    }
  }, []);

  return {
    exportData,
    exporting,
    error,
  };
}

// Hook for data clearing
export function useDataClear() {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearEvents = useCallback(async () => {
    try {
      setClearing(true);
      setError(null);
      await debugApi.clearEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setClearing(false);
    }
  }, []);

  const clearMetrics = useCallback(async () => {
    try {
      setClearing(true);
      setError(null);
      await debugApi.clearMetrics();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setClearing(false);
    }
  }, []);

  const clearAll = useCallback(async () => {
    try {
      setClearing(true);
      setError(null);
      await debugApi.clearAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setClearing(false);
    }
  }, []);

  return {
    clearEvents,
    clearMetrics,
    clearAll,
    clearing,
    error,
  };
}

// Hook for dynamic routing configuration
export function useRoutingConfig() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getRoutingConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      return await debugApi.getRoutingConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const updateRoutingConfig = useCallback(async (config: any) => {
    try {
      setLoading(true);
      setError(null);
      await debugApi.updateRoutingConfig(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getRoutingConfig,
    updateRoutingConfig,
    loading,
    error,
  };
}

// Hook for routing rules management
export function useRoutingRules() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getRoutingRules = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      return await debugApi.getRoutingRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const createRoutingRule = useCallback(async (rule: any) => {
    try {
      setLoading(true);
      setError(null);
      await debugApi.createRoutingRule(rule);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const updateRoutingRule = useCallback(async (ruleId: string, rule: any) => {
    try {
      setLoading(true);
      setError(null);
      await debugApi.updateRoutingRule(ruleId, rule);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteRoutingRule = useCallback(async (ruleId: string) => {
    try {
      setLoading(true);
      setError(null);
      await debugApi.deleteRoutingRule(ruleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const testRoutingRule = useCallback(async (request: any) => {
    try {
      setLoading(true);
      setError(null);
      return await debugApi.testRoutingRule(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getRoutingRules,
    createRoutingRule,
    updateRoutingRule,
    deleteRoutingRule,
    testRoutingRule,
    loading,
    error,
  };
}

// Hook for routing providers and stats
export function useRoutingInfo() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      return await debugApi.getRoutingProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const getStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      return await debugApi.getRoutingStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getProviders,
    getStats,
    loading,
    error,
  };
}