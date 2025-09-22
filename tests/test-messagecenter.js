#!/usr/bin/env node

/**
 * Test script to verify MessageCenter functionality in RouteCodex
 */

import { RouteCodexServer } from '../dist/server/RouteCodexServer.js';

async function testMessageCenter() {
  console.log('🧪 Testing MessageCenter functionality...\n');

  // Create test server configuration
  const config = {
    server: {
      port: 5507,
      host: 'localhost'
    },
    logging: {
      level: 'debug',
      enableConsole: true,
      enableFile: false
    },
    providers: {}
  };

  try {
    // Create server instance (this will initialize BaseModule and MessageCenter)
    const server = new RouteCodexServer(config);

    // Test 1: Check if MessageCenter is accessible
    console.log('✅ Test 1: Checking MessageCenter accessibility...');
    if ((server as any).messageCenter) {
      console.log('   MessageCenter is accessible via BaseModule');
    } else {
      console.log('❌ MessageCenter is not accessible');
      return false;
    }

    // Test 2: Check if module is registered
    console.log('\n✅ Test 2: Checking module registration...');
    const moduleId = server.getModuleInfo().id;
    console.log(`   Module ID: ${moduleId}`);

    // Test 3: Try to send a message
    console.log('\n✅ Test 3: Testing message sending...');
    try {
      await (server as any).sendMessage('test-message', {
        content: 'Test message from RouteCodex',
        timestamp: Date.now()
      });
      console.log('   Message sent successfully');
    } catch (error) {
      console.log('❌ Failed to send message:', error);
      return false;
    }

    // Test 4: Try to broadcast a message
    console.log('\n✅ Test 4: Testing message broadcasting...');
    try {
      await (server as any).broadcastMessage('broadcast-test', {
        content: 'Broadcast test message',
        timestamp: Date.now()
      });
      console.log('   Broadcast message sent successfully');
    } catch (error) {
      console.log('❌ Failed to broadcast message:', error);
      return false;
    }

    // Test 5: Check MessageCenter statistics
    console.log('\n✅ Test 5: Checking MessageCenter statistics...');
    try {
      const stats = (server as any).messageCenter.getStatistics();
      console.log('   MessageCenter Stats:', JSON.stringify(stats, null, 2));
    } catch (error) {
      console.log('❌ Failed to get statistics:', error);
      return false;
    }

    console.log('\n🎉 All MessageCenter tests passed!');
    return true;

  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

// Run the test
testMessageCenter()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test script error:', error);
    process.exit(1);
  });