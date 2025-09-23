/**
 * RouteCodex Debug Native WebSocket Service
 * Compatible with simple WebSocket server
 */

// Types are used in the class implementation

export interface NativeWebSocketServiceOptions {
  url: string;
  autoConnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export class NativeDebugWebSocketService {
  private socket: WebSocket | null = null;
  private options: NativeWebSocketServiceOptions;
  private reconnectAttempts = 0;
  private isConnected = false;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: NativeWebSocketServiceOptions) {
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
    if (this.socket?.readyState === WebSocket.OPEN) {
      console.log('WebSocket already connected');
      return;
    }

    console.log('Connecting to WebSocket:', this.options.url);

    try {
      this.socket = new WebSocket(this.options.url);
      this.setupEventHandlers();
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      this.handleConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      console.log('Disconnecting WebSocket');
      this.socket.close();
      this.socket = null;
      this.isConnected = false;
    }
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.onopen = () => {
      console.log('WebSocket connected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected', { socket: this.socket });
    };

    this.socket.onclose = (event) => {
      console.log('WebSocket disconnected:', event.code, event.reason);
      this.isConnected = false;
      this.emit('disconnected', { code: event.code, reason: event.reason });

      // Auto-reconnect if not manually disconnected
      if (this.reconnectAttempts < this.options.maxReconnectAttempts!) {
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.isConnected = false;
      this.emit('error', { error: 'WebSocket connection error' });
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
        this.emit('parse_error', { rawMessage: event.data });
      }
    };
  }

  private handleMessage(data: any): void {
    switch (data.type) {
      case 'connected':
        this.emit('connected', data.data);
        break;

      case 'module_status':
        this.emit('module_status', data.data);
        break;

      case 'debug_event':
        this.emit('debug_event', data.data);
        break;

      case 'heartbeat':
        this.emit('heartbeat', data.data);
        break;

      case 'error':
        this.emit('error_event', data.data);
        break;

      case 'pong':
        this.emit('pong', data.data);
        break;

      default:
        console.log('Unknown message type:', data.type);
        this.emit('unknown_message', data);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts}`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectInterval);
  }

  private handleConnectionError(errorMessage: string): void {
    this.emit('error', { error: errorMessage });

    if (this.reconnectAttempts < this.options.maxReconnectAttempts!) {
      this.scheduleReconnect();
    }
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
    if (this.socket?.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({
        type: command,
        data: data || {},
        timestamp: Date.now()
      });
      this.socket.send(message);
    } else {
      console.warn('WebSocket not connected, cannot send command:', command);
    }
  }

  // Request data from server
  requestData(type: string, filters?: any): void {
    this.sendCommand('get_' + type, filters);
  }

  // Debug controls
  startDebugging(moduleId: string): void {
    this.sendCommand('start_debugging', { moduleId });
  }

  stopDebugging(moduleId: string): void {
    this.sendCommand('stop_debugging', { moduleId });
  }

  // Ping/Pong for connection health
  ping(): void {
    this.sendCommand('ping');
  }

  // Utility methods
  isConnectedToServer(): boolean {
    return this.isConnected && this.socket?.readyState === WebSocket.OPEN;
  }

  getConnectionStatus(): {
    connected: boolean;
    reconnectAttempts: number;
    readyState?: number;
  } {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      readyState: this.socket?.readyState
    };
  }

  // Get detailed connection state
  getDetailedStatus(): {
    connected: boolean;
    readyState: number | null;
    reconnectAttempts: number;
    url: string;
  } {
    return {
      connected: this.isConnected,
      readyState: this.socket?.readyState || null,
      reconnectAttempts: this.reconnectAttempts,
      url: this.options.url
    };
  }
}


// Factory function to create the appropriate WebSocket service
export function createWebSocketService(useNative: boolean = true, options: NativeWebSocketServiceOptions) {
  if (useNative) {
    return new NativeDebugWebSocketService(options);
  } else {
    // Fallback to Socket.IO if needed
    // Note: Dynamic import to avoid require() in ES modules
    return null; // Placeholder for Socket.IO fallback
  }
}

// Default singleton instance using native WebSocket
export const debugWebSocket = new NativeDebugWebSocketService({
  url: 'ws://localhost:5507',
  autoConnect: false,
});