/**
 * Integration test for DebugCenter with topic subscription
 * DebugCenter 主题订阅集成测试
 */

import { DebugCenterWithTopicSubscription } from './node_modules/rcc-debugcenter/dist/index.esm.js';
import { MessageCenter } from './node_modules/rcc-basemodule/dist/index.esm.js';

async function testDebugCenterTopicSubscription() {
  console.log('🧪 Testing DebugCenter Topic Subscription Integration...\n');

  try {
    // Create MessageCenter instance
    const messageCenter = new MessageCenter();

    // Store the MessageCenter globally for DebugCenter to use
    global.messageCenter = messageCenter;

    // Create DebugCenter with topic subscription enabled (will use global MessageCenter)
    const debugCenter = new DebugCenterWithTopicSubscription({
      outputDirectory: './test-debug-logs',
      enableTopicSubscription: true,
      topicSubscriptionConfig: {
        debugTopic: 'test-debug-events',
        systemTopic: 'test-system-events',
        enableWildcardSubscription: true
      }
    });

    // Allow time for initialization
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('✅ DebugCenter initialized with topic subscription');

    // Test 1: Check initialization
    console.log('\n1. Testing initialization...');
    const stats = debugCenter.getStats();
    console.log('   Topic Subscription Enabled:', stats.topicSubscription.enabled);
    console.log('   MessageCenter Initialized:', stats.topicSubscription.messageCenterInitialized);
    console.log('   Debug Topic:', stats.topicSubscription.debugTopic);
    console.log('   System Topic:', stats.topicSubscription.systemTopic);
    console.log('   Wildcard Enabled:', stats.topicSubscription.wildcardEnabled);

    if (stats.topicSubscription.enabled && stats.topicSubscription.messageCenterInitialized) {
      console.log('✅ Initialization test passed');
    } else {
      console.log('❌ Initialization test failed');
      return false;
    }

    // Test 2: Check topic subscriptions
    console.log('\n2. Testing topic subscriptions...');
    const debugSubscribers = messageCenter.getTopicSubscribers('test-debug-events');
    const systemSubscribers = messageCenter.getTopicSubscribers('test-system-events');

    console.log('   Debug Topic Subscribers:', debugSubscribers.length);
    console.log('   System Topic Subscribers:', systemSubscribers.length);

    if (debugSubscribers.length > 0 && systemSubscribers.length > 0) {
      console.log('✅ Topic subscription test passed');
    } else {
      console.log('❌ Topic subscription test failed');
      return false;
    }

    // Test 3: Test debug event publishing
    console.log('\n3. Testing debug event publishing...');
    const testEvent = {
      moduleId: 'test-module',
      operationId: 'test-operation',
      timestamp: Date.now(),
      type: 'start',
      position: 'start',
      data: { message: 'Test debug event' }
    };

    const initialQueueSize = stats.eventBus.queueSize;
    await debugCenter.publishDebugEvent('test-debug-events', testEvent);

    // Allow time for async processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const updatedStats = debugCenter.getStats();
    console.log('   Initial Queue Size:', initialQueueSize);
    console.log('   Updated Queue Size:', updatedStats.eventBus.queueSize);

    if (updatedStats.eventBus.queueSize > initialQueueSize) {
      console.log('✅ Debug event publishing test passed');
    } else {
      console.log('❌ Debug event publishing test failed');
      return false;
    }

    // Test 4: Test topic message handling
    console.log('\n4. Testing topic message handling...');

    // Create a test module to receive messages
    const testModule = {
      id: 'test-receiver',
      receivedMessages: [],
      getId: () => 'test-receiver',
      handleMessage: async (message) => {
        testModule.receivedMessages.push(message);
      }
    };

    // Register test module
    messageCenter.registerModule('test-receiver', testModule);
    messageCenter.subscribeToTopic('test-receiver', 'test-debug-events');

    // Publish a message to debug topic
    const testMessage = {
      id: 'test-msg-1',
      type: 'debug-event',
      source: 'debugcenter',
      target: 'test-debug-events',
      topic: 'test-debug-events',
      payload: {
        eventType: 'start',
        operationId: 'test-op',
        position: 'start',
        data: { message: 'Test message' }
      },
      timestamp: Date.now()
    };

    const deliveredTo = messageCenter.publishToTopic('test-debug-events', testMessage);

    // Allow time for async processing
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log('   Message delivered to:', deliveredTo.join(', '));
    console.log('   Test module received messages:', testModule.receivedMessages.length);

    if (deliveredTo.includes('test-receiver') && testModule.receivedMessages.length > 0) {
      console.log('✅ Topic message handling test passed');
    } else {
      console.log('❌ Topic message handling test failed');
      return false;
    }

    // Test 5: Test wildcard subscription
    console.log('\n5. Testing wildcard subscription...');

    // Clear previous messages
    testModule.receivedMessages = [];

    // Subscribe to wildcard
    messageCenter.subscribeToTopic('test-receiver', '*', { wildcard: true });

    // Publish to a different topic
    const wildcardMessage = {
      id: 'test-msg-2',
      type: 'system-event',
      source: 'system',
      target: 'other-topic',
      topic: 'other-topic',
      payload: { event: 'system started' },
      timestamp: Date.now()
    };

    messageCenter.publishToTopic('other-topic', wildcardMessage);

    // Allow time for async processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const wildcardMessages = testModule.receivedMessages.filter(msg => msg.topic === 'other-topic');
    console.log('   Wildcard messages received:', wildcardMessages.length);

    if (wildcardMessages.length > 0) {
      console.log('✅ Wildcard subscription test passed');
    } else {
      console.log('❌ Wildcard subscription test failed');
      return false;
    }

    // Cleanup
    debugCenter.destroy();
    messageCenter.destroy();

    console.log('\n🎉 All DebugCenter topic subscription tests passed!');
    return true;

  } catch (error) {
    console.error('\n💥 Test failed with error:', error);
    return false;
  }
}

// Run the test
testDebugCenterTopicSubscription()
  .then(success => {
    if (success) {
      console.log('\n✅ DebugCenter topic subscription integration is working correctly');
      process.exit(0);
    } else {
      console.log('\n❌ DebugCenter topic subscription integration has issues');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('\n💥 Test failed with error:', error);
    process.exit(1);
  });