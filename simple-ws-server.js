/**
 * Simple WebSocket Server for Testing
 */

import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 5507 });

console.log('🚀 Simple WebSocket Server running on ws://localhost:5507');

// Store connected clients
const clients = new Set();

wss.on('connection', (ws, req) => {
  console.log('Client connected from:', req.socket.remoteAddress);
  clients.add(ws);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    data: {
      message: 'Connected to RouteCodex Debug Server',
      timestamp: Date.now(),
      clientId: clients.size
    }
  }));

  // Send sample module status
  ws.send(JSON.stringify({
    type: 'module_status',
    data: {
      'http-server': {
        moduleId: 'http-server',
        enabled: true,
        isActive: true,
        lastActivity: Date.now(),
        stats: { requestsHandled: 42, averageResponseTime: 156 },
        health: 'healthy',
        version: '1.0.0'
      },
      'pipeline-manager': {
        moduleId: 'pipeline-manager',
        enabled: true,
        isActive: true,
        lastActivity: Date.now(),
        stats: { pipelineCount: 3, requestsProcessed: 128 },
        health: 'healthy',
        version: '1.0.0'
      }
    }
  }));

  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received message:', data);

      // Handle different message types
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            data: { timestamp: Date.now() }
          }));
          break;

        case 'start_debugging':
          ws.send(JSON.stringify({
            type: 'debug_event',
            data: {
              sessionId: 'session-' + Date.now(),
              moduleId: data.data?.moduleId || 'unknown',
              operationId: 'start-debugging',
              timestamp: Date.now(),
              type: 'start',
              position: 'start',
              message: `Started debugging ${data.data?.moduleId || 'unknown module'}`
            }
          }));
          break;

        case 'get_events':
          // Send some sample events
          const sampleEvents = [
            {
              sessionId: 'sample-001',
              moduleId: 'http-server',
              operationId: 'request-start',
              timestamp: Date.now() - 5000,
              type: 'start',
              position: 'start',
              data: {
                input: { method: 'GET', url: '/api/test' },
                performance: { startTime: Date.now() - 5000, duration: 156 }
              }
            },
            {
              sessionId: 'sample-002',
              moduleId: 'pipeline-manager',
              operationId: 'pipeline-select',
              timestamp: Date.now() - 3000,
              type: 'end',
              position: 'end',
              data: {
                output: { pipelineId: 'qwen-pipeline', success: true },
                performance: { startTime: Date.now() - 4000, duration: 1000 }
              }
            }
          ];

          sampleEvents.forEach(event => {
            ws.send(JSON.stringify({
              type: 'debug_event',
              data: event
            }));
          });
          break;

        default:
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Unknown message type: ' + data.type }
          }));
      }
    } catch (error) {
      console.error('Error parsing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid JSON format' }
      }));
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });

  // Send periodic heartbeat events
  const heartbeatInterval = setInterval(() => {
    if (clients.has(ws) && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        data: {
          timestamp: Date.now(),
          connectedClients: clients.size
        }
      }));
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 5000);
});

// Handle server errors
wss.on('error', (error) => {
  console.error('WebSocket Server error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down WebSocket server...');

  // Close all client connections
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Server shutting down');
    }
  });

  // Close server
  wss.close(() => {
    console.log('WebSocket server stopped');
    process.exit(0);
  });
});

console.log('✅ WebSocket server is ready for connections');
console.log('📡 Test with: ws://localhost:5507');