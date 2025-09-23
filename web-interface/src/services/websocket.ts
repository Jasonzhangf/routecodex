/**
 * RouteCodex Debug WebSocket Service
 */

import { io, Socket } from 'socket.io-client';
import { DebugEvent, SystemHealth, ModuleStatus, PerformanceMetrics } from '../types';

export interface WebSocketServiceOptions {
  url: string;
  autoConnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export class DebugWebSocketService {
  private socket: Socket | null = null;
  private options: WebSocketServiceOptions;
  private reconnectAttempts = 0;
  private isConnected = false;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();

  constructor(options: WebSocketServiceOptions) {
    this.options = {
      autoConnect: true,
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      ...options,
    };

    if (this.options.autoConnect) {
      this.connect();
    }
  }

  connect(): void {
    if (this.socket?.connected) {
      console.log('WebSocket already connected');
      return;
    }

    console.log('Connecting to WebSocket:', this.options.url);

    this.socket = io(this.options.url, {
      transports: ['websocket'],
      timeout: 10000,
      reconnection: true,
      reconnectionAttempts: this.options.maxReconnectAttempts,
      reconnectionDelay: this.options.reconnectInterval,
    });

    this.setupEventHandlers();
  }

  disconnect(): void {
    if (this.socket) {
      console.log('Disconnecting WebSocket');
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected', { socketId: this.socket?.id });
    });

    this.socket.on('disconnect', (reason) => {
      console.log('WebSocket disconnected:', reason);
      this.isConnected = false;
      this.emit('disconnected', { reason });
    });

    this.socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      this.isConnected = false;
      this.emit('error', { error: error.message });
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log('WebSocket reconnected:', attemptNumber);
      this.reconnectAttempts = 0;
      this.emit('reconnected', { attemptNumber });
    });

    this.socket.on('reconnect_error', (error) => {
      console.error('WebSocket reconnect error:', error);
      this.reconnectAttempts++;
      this.emit('reconnect_error', { error: error.message, attempt: this.reconnectAttempts });
    });

    this.socket.on('reconnect_failed', () => {
      console.error('WebSocket reconnection failed');
      this.emit('reconnect_failed', {});
    });

    // Debug event handlers
    this.socket.on('debug_event', (event: DebugEvent) => {
      this.emit('debug_event', event);
    });

    this.socket.on('module_status', (status: ModuleStatus) => {
      this.emit('module_status', status);
    });

    this.socket.on('system_health', (health: SystemHealth) => {
      this.emit('system_health', health);
    });

    this.socket.on('performance_metrics', (metrics: PerformanceMetrics) => {
      this.emit('performance_metrics', metrics);
    });

    this.socket.on('error_event', (error: any) => {
      this.emit('error_event', error);
    });

    this.socket.on('log_event', (log: any) => {
      this.emit('log_event', log);
    });
  }

  // Event subscription
  on(event: string, callback: (data: any) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: (data: any) => void): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(callback);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  private emit(event: string, data: any): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in WebSocket event handler for ${event}:`, error);
        }
      });
    }
  }

  // Send commands to server
  sendCommand(command: string, data?: any): void {
    if (this.socket?.connected) {
      this.socket.emit('command', { type: command, data, timestamp: Date.now() });
    } else {
      console.warn('WebSocket not connected, cannot send command:', command);
    }
  }

  // Request data from server
  requestData(type: string, filters?: any): void {
    if (this.socket?.connected) {
      this.socket.emit('request_data', { type, filters, timestamp: Date.now() });
    } else {
      console.warn('WebSocket not connected, cannot request data:', type);
    }
  }

  // Debug controls
  startDebugging(moduleId: string): void {
    this.sendCommand('start_debugging', { moduleId });
  }

  stopDebugging(moduleId: string): void {
    this.sendCommand('stop_debugging', { moduleId });
  }

  clearEvents(): void {
    this.sendCommand('clear_events');
  }

  exportData(format: 'json' | 'csv'): void {
    this.sendCommand('export_data', { format });
  }

  // Utility methods
  isConnectedToServer(): boolean {
    return this.isConnected;
  }

  getConnectionStatus(): {
    connected: boolean;
    reconnectAttempts: number;
    socketId?: string;
  } {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      socketId: this.socket?.id,
    };
  }

  // Subscribe to specific event types
  subscribeToEventTypes(types: string[]): void {
    this.sendCommand('subscribe_events', { types });
  }

  unsubscribeFromEventTypes(types: string[]): void {
    this.sendCommand('unsubscribe_events', { types });
  }

  // Subscribe to module updates
  subscribeToModuleUpdates(moduleIds: string[]): void {
    this.sendCommand('subscribe_modules', { moduleIds });
  }

  unsubscribeFromModuleUpdates(moduleIds: string[]): void {
    this.sendCommand('unsubscribe_modules', { moduleIds });
  }
}

// Singleton instance
export const debugWebSocket = new DebugWebSocketService({
  url: 'ws://localhost:5507',
  autoConnect: false,
});