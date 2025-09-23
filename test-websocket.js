/**
 * Test WebSocket Connection
 */

import WebSocket from 'ws';

console.log('🔌 Testing WebSocket connection to ws://localhost:5507...');

const ws = new WebSocket('ws://localhost:5507');

ws.on('open', () => {
  console.log('✅ WebSocket connected successfully!');

  // Send a test message
  const testMessage = {
    type: 'ping',
    data: { timestamp: Date.now() }
  };

  ws.send(JSON.stringify(testMessage));
  console.log('📤 Sent test message:', testMessage);
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('📥 Received message:', message);

    // Close connection after receiving response
    setTimeout(() => {
      ws.close();
      console.log('🔌 Connection closed');
      process.exit(0);
    }, 1000);
  } catch (error) {
    console.error('❌ Error parsing message:', error);
    console.log('Raw data:', data.toString());
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log('🔌 WebSocket closed:', code, reason.toString());
});

// Timeout after 10 seconds
setTimeout(() => {
  console.error('❌ Connection timeout');
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  process.exit(1);
}, 10000);