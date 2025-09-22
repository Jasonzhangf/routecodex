import { MessageCenter } from 'rcc-basemodule';

// Mock module class for testing
class TestModule {
  constructor(id) {
    this.id = id;
    this.receivedMessages = [];
  }

  getId() {
    return this.id;
  }

  async handleMessage(message) {
    this.receivedMessages.push(message);
  }

  getReceivedMessages() {
    return this.receivedMessages;
  }

  clearMessages() {
    this.receivedMessages = [];
  }
}

async function testTopicSubscription() {
  console.log('Testing Topic Subscription functionality...\n');

  // Create MessageCenter instance
  const messageCenter = new MessageCenter();

  // Create test modules
  const module1 = new TestModule('module1');
  const module2 = new TestModule('module2');
  const module3 = new TestModule('module3');

  // Register modules
  messageCenter.registerModule('module1', module1);
  messageCenter.registerModule('module2', module2);
  messageCenter.registerModule('module3', module3);

  console.log('✓ Modules registered successfully');

  // Test 1: Basic topic subscription
  console.log('\n1. Testing basic topic subscription...');
  messageCenter.subscribeToTopic('module1', 'user-events');
  messageCenter.subscribeToTopic('module2', 'user-events');

  const isSubscribed1 = messageCenter.isSubscribed('module1', 'user-events');
  const isSubscribed2 = messageCenter.isSubscribed('module2', 'user-events');
  const isSubscribed3 = messageCenter.isSubscribed('module3', 'user-events');

  console.log(`  Module1 subscribed to user-events: ${isSubscribed1}`);
  console.log(`  Module2 subscribed to user-events: ${isSubscribed2}`);
  console.log(`  Module3 subscribed to user-events: ${isSubscribed3}`);

  if (isSubscribed1 && isSubscribed2 && !isSubscribed3) {
    console.log('✓ Basic subscription works correctly');
  } else {
    console.log('✗ Basic subscription failed');
    return false;
  }

  // Test 2: Get topic subscribers
  console.log('\n2. Testing get topic subscribers...');
  const subscribers = messageCenter.getTopicSubscribers('user-events');
  console.log(`  Subscribers for user-events: ${subscribers.join(', ')}`);

  if (subscribers.includes('module1') && subscribers.includes('module2') && !subscribers.includes('module3')) {
    console.log('✓ Get subscribers works correctly');
  } else {
    console.log('✗ Get subscribers failed');
    return false;
  }

  // Test 3: Topic-based message publishing
  console.log('\n3. Testing topic-based message publishing...');

  // Clear any existing messages from registration
  module1.clearMessages();
  module2.clearMessages();
  module3.clearMessages();

  const testMessage = {
    id: 'test-message-1',
    type: 'user-created',
    source: 'test-source',
    payload: { userId: '123', action: 'create' },
    timestamp: Date.now()
  };

  const deliveredTo = messageCenter.publishToTopic('user-events', testMessage);
  console.log(`  Message delivered to: ${deliveredTo.join(', ')}`);

  // Wait for async delivery
  await new Promise(resolve => setTimeout(resolve, 100));

  const module1Messages = module1.getReceivedMessages();
  const module2Messages = module2.getReceivedMessages();
  const module3Messages = module3.getReceivedMessages();

  console.log(`  Module1 received: ${module1Messages.length} messages`);
  console.log(`  Module2 received: ${module2Messages.length} messages`);
  console.log(`  Module3 received: ${module3Messages.length} messages`);

  // Filter for topic messages
  const topicMessages1 = module1Messages.filter(msg => msg.topic === 'user-events');
  const topicMessages2 = module2Messages.filter(msg => msg.topic === 'user-events');
  const topicMessages3 = module3Messages.filter(msg => msg.topic === 'user-events');

  console.log(`  Module1 topic messages: ${topicMessages1.length}`);
  console.log(`  Module2 topic messages: ${topicMessages2.length}`);
  console.log(`  Module3 topic messages: ${topicMessages3.length}`);

  if (topicMessages1.length === 1 && topicMessages2.length === 1 && topicMessages3.length === 0) {
    console.log('✓ Topic-based publishing works correctly');
  } else {
    console.log('✗ Topic-based publishing failed');
    // Debug: show message types
    console.log('  Module1 message types:', module1Messages.map(m => m.type));
    console.log('  Module2 message types:', module2Messages.map(m => m.type));
    return false;
  }

  // Test 4: Wildcard subscription
  console.log('\n4. Testing wildcard subscription...');
  module1.clearMessages();
  module2.clearMessages();
  module3.clearMessages();

  messageCenter.subscribeToTopic('module3', '*', { wildcard: true });
  const systemMessage = {
    id: 'test-message-2',
    type: 'system-event',
    source: 'test-source',
    payload: { event: 'system-started' },
    timestamp: Date.now()
  };

  messageCenter.publishToTopic('system-events', systemMessage);

  // Wait for async delivery
  await new Promise(resolve => setTimeout(resolve, 100));

  const module1Messages2 = module1.getReceivedMessages().length;
  const module2Messages2 = module2.getReceivedMessages().length;
  const module3Messages2 = module3.getReceivedMessages().length;

  console.log(`  Module1 received: ${module1Messages2} system messages`);
  console.log(`  Module2 received: ${module2Messages2} system messages`);
  console.log(`  Module3 received: ${module3Messages2} system messages`);

  if (module1Messages2 === 0 && module2Messages2 === 0 && module3Messages2 === 1) {
    console.log('✓ Wildcard subscription works correctly');
  } else {
    console.log('✗ Wildcard subscription failed');
    return false;
  }

  // Test 5: Get module subscriptions
  console.log('\n5. Testing get module subscriptions...');
  const module1Subscriptions = messageCenter.getModuleSubscriptions('module1');
  const module3Subscriptions = messageCenter.getModuleSubscriptions('module3');

  console.log(`  Module1 subscriptions: ${module1Subscriptions.join(', ')}`);
  console.log(`  Module3 subscriptions: ${module3Subscriptions.join(', ')}`);

  if (module1Subscriptions.includes('user-events') && module3Subscriptions.includes('*')) {
    console.log('✓ Get module subscriptions works correctly');
  } else {
    console.log('✗ Get module subscriptions failed');
    return false;
  }

  // Test 6: Unsubscription
  console.log('\n6. Testing unsubscription...');
  messageCenter.unsubscribeFromTopic('module1', 'user-events');
  const stillSubscribed = messageCenter.isSubscribed('module1', 'user-events');

  console.log(`  Module1 still subscribed after unsubscribe: ${stillSubscribed}`);

  if (!stillSubscribed) {
    console.log('✓ Unsubscription works correctly');
  } else {
    console.log('✗ Unsubscription failed');
    return false;
  }

  // Test 7: Get all topics
  console.log('\n7. Testing get all topics...');
  const allTopics = messageCenter.getAllTopics();
  console.log(`  Active topics: ${allTopics.join(', ')}`);

  if (allTopics.includes('user-events')) {
    console.log('✓ Get all topics works correctly');
    console.log('  Note: system-events not in active topics because only wildcard subscription exists');
  } else {
    console.log('✗ Get all topics failed');
    return false;
  }

  // Test 8: Subscription statistics
  console.log('\n8. Testing subscription statistics...');
  const stats = messageCenter.getSubscriptionStats();
  console.log(`  Total topics: ${stats.totalTopics}`);
  console.log(`  Total subscriptions: ${stats.totalSubscriptions}`);
  console.log(`  Wildcard subscriptions: ${stats.wildcardSubscriptions}`);

  if (stats.totalTopics === 1 && stats.totalSubscriptions === 1 && stats.wildcardSubscriptions === 1) {
    console.log('✓ Subscription statistics work correctly');
  } else {
    console.log('✗ Subscription statistics failed');
    return false;
  }

  // Clean up
  messageCenter.destroy();

  console.log('\n🎉 All topic subscription tests passed successfully!');
  return true;
}

// Run the test
testTopicSubscription()
  .then(success => {
    if (success) {
      console.log('\n✅ Topic subscription functionality is working correctly');
      process.exit(0);
    } else {
      console.log('\n❌ Topic subscription functionality has issues');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('\n💥 Test failed with error:', error);
    process.exit(1);
  });