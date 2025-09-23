/**
 * Test WebSocket Events
 */

import WebSocket from 'ws';

console.log('🔌 Testing WebSocket events...');

const ws = new WebSocket('ws://localhost:5507');

ws.on('open', () => {
  console.log('✅ WebSocket connected successfully!');

  // Request events
  const requestMessage = {
    type: 'get_events',
    data: { limit: 5 }
  };

  ws.send(JSON.stringify(requestMessage));
  console.log('📤 Sent events request:', requestMessage);

  // Start debugging a test module
  setTimeout(() => {
    const startDebugMessage = {
      type: 'start_debugging',
      data: { moduleId: 'test-module' }
    };
    ws.send(JSON.stringify(startDebugMessage));
    console.log('📤 Sent start debugging:', startDebugMessage);
  }, 1000);
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('📥 Received message:', message.type);

    if (message.type === 'debug_event') {
      console.log('   Debug Event:', message.data.operationId, 'from', message.data.moduleId);
    } else if (message.type === 'module_status') {
      const modules = Object.keys(message.data);
      console.log('   Module Status:', modules.length, 'modules');
    } else {
      console.log('   Data:', JSON.stringify(message.data).substring(0, 100));
    }
  } catch (error) {
    console.error('❌ Error parsing message:', error);
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
});

ws.on('close', (code, reason) => {
  console.log('🔌 WebSocket closed:', code, reason.toString());
  process.exit(0);
});

// Close after 5 seconds
setTimeout(() => {
  console.log('🏁 Test completed');
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}, 5000);