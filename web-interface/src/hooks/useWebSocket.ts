/**
 * Custom hook for WebSocket connections
 */

import { useEffect, useState, useCallback } from 'react';
import { debugWebSocket } from '../services/native-websocket';
import { DebugEvent, SystemHealth, ModuleStatus, PerformanceMetrics } from '../types';

interface UseWebSocketOptions {
  autoConnect?: boolean;
  eventTypes?: string[];
  moduleIds?: string[];
}

export function useWebSocket(_options: UseWebSocketOptions = {}) {
  const [isConnected, setIsConnected] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [moduleStatuses, setModuleStatuses] = useState<ModuleStatus[]>([]);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Initialize WebSocket connection
  useEffect(() => {
    const handleConnected = () => {
      setIsConnected(true);
      setError(null);

      // Request initial data
      debugWebSocket.requestData('events');
      debugWebSocket.ping(); // Test connection

      // For native WebSocket, subscription happens differently
      // The server automatically sends all module status on connection
    };

    const handleDisconnected = () => {
      setIsConnected(false);
    };

    const handleError = (data: { error: string }) => {
      setError(data.error);
    };

    // Native WebSocket doesn't have these specific events
    // Reconnection is handled automatically

    const handleDebugEvent = (event: DebugEvent) => {
      setEvents(prev => [event, ...prev].slice(0, 1000)); // Keep last 1000 events
    };

    const handleSystemHealth = (health: SystemHealth) => {
      setSystemHealth(health);
    };

    const handleModuleStatus = (status: any) => {
      // Handle both single module status and object with multiple modules
      if (typeof status === 'object' && status.moduleId) {
        // Single module status
        setModuleStatuses(prev => {
          const existingIndex = prev.findIndex(m => m.moduleId === status.moduleId);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = status;
            return updated;
          }
          return [...prev, status];
        });
      } else if (typeof status === 'object') {
        // Multiple modules status object
        Object.values(status).forEach((moduleStatus: any) => {
          if (moduleStatus.moduleId) {
            setModuleStatuses(prev => {
              const existingIndex = prev.findIndex(m => m.moduleId === moduleStatus.moduleId);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = moduleStatus;
                return updated;
              }
              return [...prev, moduleStatus];
            });
          }
        });
      }
    };

    const handlePerformanceMetrics = (metrics: PerformanceMetrics) => {
      setPerformanceMetrics(prev => [...prev, metrics].slice(-100)); // Keep last 100 metrics
    };

    // Register event listeners
    debugWebSocket.on('connected', handleConnected);
    debugWebSocket.on('disconnected', handleDisconnected);
    debugWebSocket.on('error', handleError);
    debugWebSocket.on('debug_event', handleDebugEvent);
    debugWebSocket.on('system_health', handleSystemHealth);
    debugWebSocket.on('module_status', handleModuleStatus);
    debugWebSocket.on('performance_metrics', handlePerformanceMetrics);
    debugWebSocket.on('heartbeat', (data: any) => {
      // Handle heartbeat events
      console.log('Heartbeat received:', data);
    });

    // Update connection status
    const updateConnectionStatus = () => {
      setIsConnected(debugWebSocket.isConnectedToServer());
    };

    updateConnectionStatus();

    // Clean up event listeners
    return () => {
      debugWebSocket.off('connected', handleConnected);
      debugWebSocket.off('disconnected', handleDisconnected);
      debugWebSocket.off('error', handleError);
      debugWebSocket.off('debug_event', handleDebugEvent);
      debugWebSocket.off('system_health', handleSystemHealth);
      debugWebSocket.off('module_status', handleModuleStatus);
      debugWebSocket.off('performance_metrics', handlePerformanceMetrics);
      debugWebSocket.off('heartbeat', () => {});
    };
  }, []); // Remove dependencies since they're not used in native WebSocket

  // Connect/disconnect methods
  const connect = useCallback(() => {
    debugWebSocket.connect();
  }, []);

  const disconnect = useCallback(() => {
    debugWebSocket.disconnect();
  }, []);

  // Control methods
  const startDebugging = useCallback((moduleId: string) => {
    debugWebSocket.startDebugging(moduleId);
  }, []);

  const stopDebugging = useCallback((moduleId: string) => {
    debugWebSocket.stopDebugging(moduleId);
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]); // Just clear local events
  }, []);

  // Data refresh methods
  const refreshSystemHealth = useCallback(() => {
    debugWebSocket.ping(); // Simple ping to refresh connection
  }, []);

  const refreshModuleStatuses = useCallback(() => {
    debugWebSocket.requestData('events'); // Request events which include module status
  }, []);

  const refreshPerformanceMetrics = useCallback(() => {
    debugWebSocket.ping(); // Simple ping to refresh connection
  }, []);

  return {
    isConnected,
    events,
    systemHealth,
    moduleStatuses,
    performanceMetrics,
    error,
    connect,
    disconnect,
    startDebugging,
    stopDebugging,
    clearEvents,
    refreshSystemHealth,
    refreshModuleStatuses,
    refreshPerformanceMetrics,
    connectionStatus: debugWebSocket.getConnectionStatus(),
  };
}