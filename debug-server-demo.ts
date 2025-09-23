/**
 * Simple Debug Server Demo for WebSocket Testing
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

const PORT = 5507;

// Store connected clients
const connectedClients = new Set();

// Simulated debug events
const sampleEvents = [
  {
    sessionId: 'session-001',
    moduleId: 'http-server',
    operationId: 'request-start',
    timestamp: Date.now(),
    type: 'start',
    position: 'start',
    data: {
      input: { method: 'GET', url: '/api/test' },
      performance: { startTime: Date.now() }
    }
  },
  {
    sessionId: 'session-002',
    moduleId: 'pipeline-manager',
    operationId: 'pipeline-select',
    timestamp: Date.now(),
    type: 'start',
    position: 'start',
    data: {
      input: { providerId: 'qwen', modelId: 'qwen-turbo' },
      performance: { startTime: Date.now() }
    }
  }
];

// Simulated module status
const moduleStatus = {
  'http-server': {
    moduleId: 'http-server',
    enabled: true,
    isActive: true,
    lastActivity: Date.now(),
    stats: { requestsHandled: 42, averageResponseTime: 156 },
    health: 'healthy' as const,
    version: '1.0.0'
  },
  'pipeline-manager': {
    moduleId: 'pipeline-manager',
    enabled: true,
    isActive: true,
    lastActivity: Date.now(),
    stats: { pipelineCount: 3, requestsProcessed: 128 },
    health: 'healthy' as const,
    version: '1.0.0'
  }
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  connectedClients.add(socket.id);

  // Send initial data
  socket.emit('connected', { socketId: socket.id });
  socket.emit('module_status', moduleStatus);

  // Handle client commands
  socket.on('command', (command) => {
    console.log('Received command:', command);

    switch (command.type) {
      case 'start_debugging':
        socket.emit('debug_event', {
          ...sampleEvents[0],
          data: { ...sampleEvents[0].data, message: `Started debugging ${command.data.moduleId}` }
        });
        break;

      case 'stop_debugging':
        socket.emit('debug_event', {
          sessionId: 'session-control',
          moduleId: 'control',
          operationId: 'stop-debugging',
          timestamp: Date.now(),
          type: 'end',
          position: 'end',
          data: { message: `Stopped debugging ${command.data.moduleId}` }
        });
        break;

      case 'clear_events':
        socket.emit('log_event', { message: 'Events cleared', timestamp: Date.now() });
        break;

      default:
        console.log('Unknown command:', command.type);
    }
  });

  // Handle data requests
  socket.on('request_data', (request) => {
    console.log('Data request:', request);

    switch (request.type) {
      case 'module_status':
        socket.emit('module_status', moduleStatus);
        break;

      case 'recent_events':
        socket.emit('debug_event', sampleEvents[0]);
        setTimeout(() => socket.emit('debug_event', sampleEvents[1]), 1000);
        break;

      default:
        console.log('Unknown data request:', request.type);
    }
  });

  // Send periodic events for demo
  const eventInterval = setInterval(() => {
    if (connectedClients.has(socket.id)) {
      const randomEvent = {
        sessionId: `session-${Math.floor(Math.random() * 1000)}`,
        moduleId: ['http-server', 'pipeline-manager'][Math.floor(Math.random() * 2)],
        operationId: ['request-start', 'pipeline-select', 'process-request'][Math.floor(Math.random() * 3)],
        timestamp: Date.now(),
        type: ['start', 'end', 'data'][Math.floor(Math.random() * 3)],
        position: ['start', 'middle', 'end'][Math.floor(Math.random() * 3)],
        data: {
          message: `Demo event ${Date.now()}`,
          performance: {
            startTime: Date.now() - Math.floor(Math.random() * 1000),
            duration: Math.floor(Math.random() * 500)
          }
        }
      };

      socket.emit('debug_event', randomEvent);
    }
  }, 3000);

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    connectedClients.delete(socket.id);
    clearInterval(eventInterval);
  });
});

// Basic health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'debug-demo',
    connectedClients: connectedClients.size,
    timestamp: Date.now()
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Debug Demo Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server ready for connections`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down debug server...');
  server.close(() => {
    console.log('Debug server stopped');
    process.exit(0);
  });
});