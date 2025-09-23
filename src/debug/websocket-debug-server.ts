/**
 * WebSocket Debug Server Implementation
 *
 * This file provides the implementation for the WebSocket debug server that enables
 * real-time debugging and monitoring of the RouteCodex system.
 */

import { DebugEventBus } from '../utils/external-mocks.js';
import { ErrorHandlerRegistry } from '../utils/error-handler-registry.js';
import { DebugUtilsStatic } from '../utils/debug-utils.js';
import type {
  WebSocketDebugServer,
  WebSocketServerStats,
  WebSocketServerHealth,
  DebugWebSocketEvent,
  DebugWebSocketMessage,
  DebugHealthIssue
} from '../types/debug-types.js';

/**
 * WebSocket Debug Server implementation
 */
export class WebSocketDebugServerImpl implements WebSocketDebugServer {
  readonly id: string = 'websocket-debug-server';
  readonly version: string = '1.0.0';
  readonly serverInfo: {
    host: string;
    port: number;
    path: string;
  };

  private debugEventBus: DebugEventBus;
  private errorRegistry: ErrorHandlerRegistry;
  private debugUtils: any; // DebugUtils instance
  private server: any; // WebSocket server instance
  private clients: Map<string, any> = new Map(); // Connected clients
  private subscriptions: Map<string, Set<string>> = new Map(); // Client subscriptions
  private startTime: number;
  private stats: WebSocketServerStats;
  private health: WebSocketServerHealth;
  private config: {
    maxConnections: number;
    enableCompression: boolean;
    enableHeartbeat: boolean;
    heartbeatInterval: number;
  };
  private heartbeatInterval?: NodeJS.Timeout;

  /**
   * Constructor
   */
  constructor(
    serverInfo: {
      host: string;
      port: number;
      path: string;
    },
    config: {
      maxConnections: number;
      enableCompression: boolean;
      enableHeartbeat: boolean;
      heartbeatInterval: number;
    }
  ) {
    this.serverInfo = serverInfo;
    this.config = config;
    this.debugEventBus = DebugEventBus.getInstance();
    this.errorRegistry = ErrorHandlerRegistry.getInstance();
    this.debugUtils = DebugUtilsStatic;
    this.startTime = Date.now();

    // Initialize statistics
    this.stats = this.createDefaultStats();

    // Initialize health
    this.health = this.createDefaultHealth();
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    try {
      // Initialize WebSocket server
      await this.initializeWebSocketServer();

      // Setup event handlers
      await this.setupEventHandlers();

      // Start heartbeat if enabled
      if (this.config.enableHeartbeat) {
        this.startHeartbeat();
      }

      // Update health status
      this.health.status = 'healthy';
      this.health.lastCheck = Date.now();
      this.health.score = 100;

      // Publish server started event
      this.publishEvent('websocket_debug_server_started', {
        serverInfo: this.serverInfo,
        config: this.config,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('start_server', error as Error);
      this.health.status = 'unhealthy';
      this.health.score = 0;
      throw error;
    }
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    try {
      // Stop heartbeat
      this.stopHeartbeat();

      // Close all client connections
      await this.closeAllClientConnections();

      // Stop WebSocket server
      await this.stopWebSocketServer();

      // Update health status
      this.health.status = 'unknown';
      this.health.lastCheck = Date.now();
      this.health.score = 0;

      // Publish server stopped event
      this.publishEvent('websocket_debug_server_stopped', {
        serverInfo: this.serverInfo,
        uptime: Date.now() - this.startTime,
        clientsClosed: this.clients.size,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('stop_server', error as Error);
      throw error;
    }
  }

  /**
   * Send debug event to connected clients
   */
  async sendEvent(event: DebugWebSocketEvent): Promise<void> {
    try {
      // Update statistics
      this.stats.totalMessagesSent++;

      // Send to all subscribed clients
      const message: DebugWebSocketMessage = {
        id: this.debugUtils.generateId('ws_msg'),
        type: 'event',
        data: event,
        timestamp: Date.now()
      };

      await this.broadcastToSubscribers(event.type, message);

      // Update bandwidth
      this.stats.bandwidth.sent += JSON.stringify(message).length;

    } catch (error) {
      await this.handleError('send_event', error as Error, { event });
    }
  }

  /**
   * Broadcast message to all clients
   */
  async broadcast(message: DebugWebSocketMessage): Promise<void> {
    try {
      // Update statistics
      this.stats.totalMessagesSent++;

      // Send to all connected clients
      const messageStr = JSON.stringify(message);

      for (const [clientId, client] of this.clients.entries()) {
        try {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(messageStr);
          }
        } catch (error) {
          console.warn(`Failed to send message to client ${clientId}:`, error);
          this.removeClient(clientId);
        }
      }

      // Update bandwidth
      this.stats.bandwidth.sent += messageStr.length;

    } catch (error) {
      await this.handleError('broadcast', error as Error, { message });
    }
  }

  /**
   * Get server statistics
   */
  getStats(): WebSocketServerStats {
    // Update uptime
    this.stats.uptime = Date.now() - this.startTime;

    return {
      ...this.stats,
      bandwidth: { ...this.stats.bandwidth }
    };
  }

  /**
   * Get server health
   */
  getHealth(): WebSocketServerHealth {
    // Perform quick health check
    this.performHealthCheck();

    return {
      ...this.health,
      issues: [...this.health.issues]
    };
  }

  /**
   * Initialize WebSocket server
   */
  private async initializeWebSocketServer(): Promise<void> {
    // This would typically create a WebSocket server using ws or similar library
    // For now, we'll create a mock server object
    this.server = {
      address: () => ({
        address: this.serverInfo.host,
        port: this.serverInfo.port
      }),
      on: (event: string, handler: Function) => {
        // Mock event handler registration
      },
      close: () => {
        // Mock server close
      }
    };

    console.log(`WebSocket debug server initialized on ${this.serverInfo.host}:${this.serverInfo.port}${this.serverInfo.path}`);
  }

  /**
   * Setup event handlers
   */
  private async setupEventHandlers(): Promise<void> {
    // Setup connection handler
    this.server.on('connection', this.handleConnection.bind(this));

    // Setup error handler
    this.server.on('error', this.handleServerError.bind(this));

    // Setup DebugEventBus subscription
    this.setupDebugEventSubscription();

    console.log('WebSocket debug server event handlers setup complete');
  }

  /**
   * Handle new client connection
   */
  private handleConnection(client: any, request: any): void {
    try {
      const clientId = this.debugUtils.generateId('ws_client');
      const clientInfo = {
        id: clientId,
        client,
        connectedAt: Date.now(),
        remoteAddress: request.socket?.remoteAddress || 'unknown',
        userAgent: request.headers?.['user-agent'] || 'unknown',
        subscriptions: new Set<string>()
      };

      // Add client
      this.clients.set(clientId, clientInfo);

      // Update statistics
      this.stats.totalConnections++;
      this.stats.activeConnections++;

      // Send welcome message
      this.sendWelcomeMessage(clientId);

      // Setup client message handler
      client.on('message', (data: any) => this.handleClientMessage(clientId, data));

      // Setup client disconnect handler
      client.on('close', () => this.handleClientDisconnect(clientId));

      // Setup client error handler
      client.on('error', (error: Error) => this.handleClientError(clientId, error));

      // Publish connection event
      this.publishEvent('websocket_client_connected', {
        clientId,
        remoteAddress: clientInfo.remoteAddress,
        totalConnections: this.stats.totalConnections,
        activeConnections: this.stats.activeConnections
      });

    } catch (error) {
      void this.handleError('handle_connection', error as Error);
    }
  }

  /**
   * Handle client message
   */
  private async handleClientMessage(clientId: string, data: any): Promise<void> {
    try {
      // Update statistics
      this.stats.totalMessagesReceived++;

      // Parse message
      let message: DebugWebSocketMessage;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        await this.sendErrorMessage(clientId, 'Invalid message format');
        return;
      }

      // Update bandwidth
      this.stats.bandwidth.received += data.length;

      // Handle message based on type
      switch (message.type) {
        case 'command':
          await this.handleClientCommand(clientId, message);
          break;
        case 'subscription':
          await this.handleClientSubscription(clientId, message);
          break;
        case 'heartbeat':
          await this.handleClientHeartbeat(clientId, message);
          break;
        default:
          await this.sendErrorMessage(clientId, `Unknown message type: ${message.type}`);
      }

    } catch (error) {
      await this.handleError('handle_client_message', error as Error, { clientId, data });
    }
  }

  /**
   * Handle client disconnect
   */
  private handleClientDisconnect(clientId: string): void {
    try {
      const client = this.clients.get(clientId);
      if (!client) {
        return;
      }

      // Remove client subscriptions
      for (const subscription of client.subscriptions) {
        const clients = this.subscriptions.get(subscription);
        if (clients) {
          clients.delete(clientId);
          if (clients.size === 0) {
            this.subscriptions.delete(subscription);
          }
        }
      }

      // Remove client
      this.clients.delete(clientId);

      // Update statistics
      this.stats.activeConnections = Math.max(0, this.stats.activeConnections - 1);

      // Publish disconnect event
      this.publishEvent('websocket_client_disconnected', {
        clientId,
        connectionDuration: Date.now() - client.connectedAt,
        activeConnections: this.stats.activeConnections
      });

    } catch (error) {
      console.warn(`Error handling client disconnect for ${clientId}:`, error);
    }
  }

  /**
   * Handle client error
   */
  private handleClientError(clientId: string, error: Error): void {
    console.warn(`WebSocket client error for ${clientId}:`, error);

    // Remove problematic client
    this.handleClientDisconnect(clientId);

    // Publish error event
    this.publishEvent('websocket_client_error', {
      clientId,
      error: error.message,
      timestamp: Date.now()
    });
  }

  /**
   * Handle server error
   */
  private handleServerError(error: Error): void {
    console.error('WebSocket server error:', error);

    // Update health status
    this.health.status = 'degraded';
    this.health.score = Math.max(0, this.health.score - 20);

    // Add health issue
    this.addHealthIssue(
      'server_error',
      'high',
      'connection',
      `WebSocket server error: ${error.message}`,
      'Check server logs and configuration'
    );

    // Publish server error event
    this.publishEvent('websocket_server_error', {
      error: error.message,
      stack: error.stack,
      timestamp: Date.now()
    });
  }

  /**
   * Handle client command
   */
  private async handleClientCommand(clientId: string, message: DebugWebSocketMessage): Promise<void> {
    const { command, params } = message.data || {};

    try {
      switch (command) {
        case 'get_stats':
          await this.sendStatsToClient(clientId);
          break;
        case 'get_health':
          await this.sendHealthToClient(clientId);
          break;
        case 'get_clients':
          await this.sendClientListToClient(clientId);
          break;
        case 'ping':
          await this.sendPongToClient(clientId);
          break;
        default:
          await this.sendErrorMessage(clientId, `Unknown command: ${command}`);
      }
    } catch (error) {
      await this.sendErrorMessage(clientId, `Command failed: ${command}`);
    }
  }

  /**
   * Handle client subscription
   */
  private async handleClientSubscription(clientId: string, message: DebugWebSocketMessage): Promise<void> {
    const { action, eventType } = message.data || {};

    try {
      const client = this.clients.get(clientId);
      if (!client) {
        return;
      }

      if (action === 'subscribe') {
        // Add subscription
        client.subscriptions.add(eventType);

        let clients = this.subscriptions.get(eventType);
        if (!clients) {
          clients = new Set();
          this.subscriptions.set(eventType, clients);
        }
        clients.add(clientId);

        await this.sendAckMessage(clientId, `Subscribed to ${eventType}`);

      } else if (action === 'unsubscribe') {
        // Remove subscription
        client.subscriptions.delete(eventType);

        const clients = this.subscriptions.get(eventType);
        if (clients) {
          clients.delete(clientId);
          if (clients.size === 0) {
            this.subscriptions.delete(eventType);
          }
        }

        await this.sendAckMessage(clientId, `Unsubscribed from ${eventType}`);

      } else {
        await this.sendErrorMessage(clientId, `Invalid subscription action: ${action}`);
      }
    } catch (error) {
      await this.sendErrorMessage(clientId, `Subscription failed: ${action}`);
    }
  }

  /**
   * Handle client heartbeat
   */
  private async handleClientHeartbeat(clientId: string, message: DebugWebSocketMessage): Promise<void> {
    const response: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'response',
      data: {
        command: 'heartbeat',
        response: 'pong',
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, response);
  }

  /**
   * Send welcome message to client
   */
  private async sendWelcomeMessage(clientId: string): Promise<void> {
    const message: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'system',
      data: {
        message: 'Welcome to RouteCodex Debug Server',
        clientId,
        serverInfo: this.serverInfo,
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, message);
  }

  /**
   * Send error message to client
   */
  private async sendErrorMessage(clientId: string, error: string): Promise<void> {
    const message: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'error',
      data: {
        error,
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, message);
  }

  /**
   * Send acknowledgment message to client
   */
  private async sendAckMessage(clientId: string, message: string): Promise<void> {
    const response: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'response',
      data: {
        command: 'ack',
        message,
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, response);
  }

  /**
   * Send stats to client
   */
  private async sendStatsToClient(clientId: string): Promise<void> {
    const response: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'response',
      data: {
        command: 'get_stats',
        stats: this.getStats(),
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, response);
  }

  /**
   * Send health to client
   */
  private async sendHealthToClient(clientId: string): Promise<void> {
    const response: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'response',
      data: {
        command: 'get_health',
        health: this.getHealth(),
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, response);
  }

  /**
   * Send client list to client
   */
  private async sendClientListToClient(clientId: string): Promise<void> {
    const clientList = Array.from(this.clients.values()).map(client => ({
      id: client.id,
      connectedAt: client.connectedAt,
      remoteAddress: client.remoteAddress,
      subscriptionCount: client.subscriptions.size
    }));

    const response: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'response',
      data: {
        command: 'get_clients',
        clients: clientList,
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, response);
  }

  /**
   * Send pong to client
   */
  private async sendPongToClient(clientId: string): Promise<void> {
    const response: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_msg'),
      type: 'response',
      data: {
        command: 'ping',
        response: 'pong',
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      clientId
    };

    await this.sendMessageToClient(clientId, response);
  }

  /**
   * Send message to specific client
   */
  private async sendMessageToClient(clientId: string, message: DebugWebSocketMessage): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || client.readyState !== 1) { // WebSocket.OPEN
      return;
    }

    try {
      const messageStr = JSON.stringify(message);
      client.send(messageStr);
      this.stats.bandwidth.sent += messageStr.length;
    } catch (error) {
      console.warn(`Failed to send message to client ${clientId}:`, error);
      this.removeClient(clientId);
    }
  }

  /**
   * Broadcast message to subscribers
   */
  private async broadcastToSubscribers(eventType: string, message: DebugWebSocketMessage): Promise<void> {
    const subscribers = this.subscriptions.get(eventType);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const messageStr = JSON.stringify(message);
    const promises: Promise<void>[] = [];

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === 1) { // WebSocket.OPEN
        promises.push(
          new Promise<void>((resolve) => {
            client.send(messageStr, (error: Error) => {
              if (error) {
                console.warn(`Failed to broadcast to client ${clientId}:`, error);
                this.removeClient(clientId);
              }
              resolve();
            });
          })
        );
      }
    }

    await Promise.all(promises);
    this.stats.bandwidth.sent += messageStr.length * subscribers.size;
  }

  /**
   * Remove client
   */
  private removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      // Close WebSocket connection
      try {
        client.close();
      } catch (error) {
        // Ignore close errors
      }

      // Handle disconnect cleanup
      this.handleClientDisconnect(clientId);
    }
  }

  /**
   * Close all client connections
   */
  private async closeAllClientConnections(): Promise<void> {
    const closePromises = Array.from(this.clients.keys()).map(clientId =>
      new Promise<void>((resolve) => {
        this.removeClient(clientId);
        resolve();
      })
    );

    await Promise.all(closePromises);
  }

  /**
   * Stop WebSocket server
   */
  private async stopWebSocketServer(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.performHeartbeat();
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * Perform heartbeat
   */
  private performHeartbeat(): void {
    const heartbeatMessage: DebugWebSocketMessage = {
      id: this.debugUtils.generateId('ws_heartbeat'),
      type: 'heartbeat',
      data: {
        message: 'Server heartbeat',
        timestamp: Date.now()
      },
      timestamp: Date.now()
    };

    this.broadcast(heartbeatMessage).catch(error => {
      console.warn('Failed to broadcast heartbeat:', error);
    });
  }

  /**
   * Setup DebugEventBus subscription
   */
  private setupDebugEventSubscription(): void {
    // Subscribe to DebugEventBus events
    this.debugEventBus.subscribe('*', (event: any) => {
      const debugEvent: DebugWebSocketEvent = {
        id: this.debugUtils.generateId('debug_event'),
        type: 'debug',
        data: event,
        timestamp: Date.now()
      };

      this.sendEvent(debugEvent).catch(error => {
        console.warn('Failed to send debug event via WebSocket:', error);
      });
    });
  }

  /**
   * Perform health check
   */
  private performHealthCheck(): void {
    const now = Date.now();
    const memUsage = process.memoryUsage();
    const memPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    // Check connection count
    if (this.stats.activeConnections > this.config.maxConnections) {
      this.health.status = 'degraded';
      this.health.score = Math.max(0, 100 - (this.stats.activeConnections / this.config.maxConnections) * 50);
      this.addHealthIssue(
        'max_connections_exceeded',
        'medium',
        'connection',
        `Active connections (${this.stats.activeConnections}) exceed maximum (${this.config.maxConnections})`,
        'Monitor connection usage and consider increasing limit'
      );
    } else {
      this.health.status = 'healthy';
      this.health.score = Math.max(0, 100 - memPercentage);
    }

    // Check memory usage
    if (memPercentage > 90) {
      this.addHealthIssue(
        'high_memory_usage',
        'high',
        'memory',
        `Memory usage is high: ${memPercentage.toFixed(2)}%`,
        'Monitor memory usage and restart if necessary'
      );
    }

    this.health.lastCheck = now;
  }

  /**
   * Add health issue
   */
  private addHealthIssue(
    id: string,
    severity: DebugHealthIssue['severity'],
    type: DebugHealthIssue['type'],
    description: string,
    recommendedAction?: string
  ): void {
    const issue: DebugHealthIssue = {
      id: `${this.id}_${id}_${Date.now()}`,
      severity,
      type,
      description,
      timestamp: Date.now(),
      recommendedAction
    };

    this.health.issues.push(issue);

    // Keep only recent issues
    if (this.health.issues.length > 50) {
      this.health.issues = this.health.issues.slice(-50);
    }
  }

  /**
   * Create default statistics
   */
  private createDefaultStats(): WebSocketServerStats {
    return {
      totalConnections: 0,
      activeConnections: 0,
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      avgMessageSize: 0,
      uptime: 0,
      bandwidth: {
        sent: 0,
        received: 0
      }
    };
  }

  /**
   * Create default health
   */
  private createDefaultHealth(): WebSocketServerHealth {
    return {
      status: 'unknown',
      lastCheck: 0,
      score: 0,
      issues: []
    };
  }

  /**
   * Handle error
   */
  private async handleError(operation: string, error: Error, context?: Record<string, any>): Promise<void> {
    await this.errorRegistry.handleError(
      error,
      `websocket_debug_${operation}`,
      this.id,
      {
        operation,
        ...context
      }
    );

    this.publishEvent('websocket_debug_error', {
      operation,
      error: error.message,
      stack: error.stack,
      context,
      timestamp: Date.now()
    });
  }

  /**
   * Publish event to DebugEventBus
   */
  private publishEvent(eventType: string, data: any): void {
    try {
      this.debugEventBus.publish({
        sessionId: `websocket_debug_${this.id}`,
        moduleId: this.id,
        operationId: eventType,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data
      });
    } catch (error) {
      console.warn(`Failed to publish debug event:`, error);
    }
  }
}