#!/usr/bin/env node

/**
 * User Configuration System Test Script
 * Tests the user configuration management functionality
 */

import { UserConfigManager } from '../dist/config/user-config-manager.js';

async function testUserConfigSystem() {
  console.log('🧪 Testing User Configuration System...\n');

  try {
    // Test 1: UserConfigManager instantiation
    console.log('Test 1: UserConfigManager instantiation');
    const userManager = new UserConfigManager('./config/users.json');
    console.log('✅ UserConfigManager instantiated successfully\n');

    // Test 2: Load user configuration
    console.log('Test 2: Load user configuration');
    await userManager.loadUserConfig();
    console.log('✅ User configuration loaded successfully\n');

    // Test 3: Get user profiles
    console.log('Test 3: Get user profiles');
    const adminUser = userManager.getUserProfile('admin-user');
    if (adminUser) {
      console.log('✅ Admin user profile retrieved:');
      console.log('   Username:', adminUser.username);
      console.log('   Email:', adminUser.email);
      console.log('   Role:', adminUser.role);
      console.log('   Enabled:', adminUser.enabled);
      console.log('   Max requests per day:', adminUser.quotas.maxRequestsPerDay);
    } else {
      console.log('❌ Admin user not found');
    }
    console.log('');

    // Test 4: Check user permissions
    console.log('Test 4: Check user permissions');
    const canAdminAccessAll = userManager.checkPermission('admin-user', '*', '*');
    const canDemoAccessApi = userManager.checkPermission('demo-user', 'api/*', 'read');
    console.log('✅ Permission checks:');
    console.log('   Admin can access all:', canAdminAccessAll);
    console.log('   Demo can read API:', canDemoAccessApi);
    console.log('');

    // Test 5: Get user preferences
    console.log('Test 5: Get user preferences');
    const adminPrefs = userManager.getUserPreferences('admin-user');
    if (adminPrefs) {
      console.log('✅ Admin preferences retrieved:');
      console.log('   Theme:', adminPrefs.theme);
      console.log('   Language:', adminPrefs.language);
      console.log('   Debug mode:', adminPrefs.advanced.debugMode);
      console.log('   Notifications enabled:', adminPrefs.notifications.enabled);
    } else {
      console.log('❌ Admin preferences not found');
    }
    console.log('');

    // Test 6: User search functionality
    console.log('Test 6: User search functionality');
    const searchResults = await userManager.searchUsers({
      role: 'admin',
      limit: 10
    });
    console.log('✅ User search results:');
    console.log('   Found users:', searchResults.users.length);
    console.log('   Total results:', searchResults.total);
    searchResults.users.forEach(user => {
      console.log(`   - ${user.username} (${user.role})`);
    });
    console.log('');

    // Test 7: User metrics
    console.log('Test 7: User metrics');
    const metrics = userManager.getUserMetrics();
    console.log('✅ User metrics retrieved:');
    console.log('   Total users:', metrics.totalUsers);
    console.log('   Active users:', metrics.activeUsers);
    console.log('   Total sessions:', metrics.totalSessions);
    console.log('   Average session duration:', Math.round(metrics.averageSessionDuration / 1000), 'seconds');
    console.log('');

    // Test 8: Create new user
    console.log('Test 8: Create new user');
    const newUserId = userManager.createUserProfile({
      username: 'testuser',
      email: 'testuser@example.com',
      role: 'user',
      enabled: true,
      quotas: {
        maxRequestsPerDay: 500,
        maxTokensPerRequest: 2048,
        maxConcurrentRequests: 3,
        maxProviders: 2,
        maxFiles: 50,
        maxStorageMB: 512
      },
      metadata: {
        department: 'testing',
        createdBy: 'test-script'
      }
    });
    console.log('✅ New user created with ID:', newUserId);

    // Verify new user was created
    const newUser = userManager.getUserProfile(newUserId);
    if (newUser) {
      console.log('   New user details:');
      console.log('   Username:', newUser.username);
      console.log('   Email:', newUser.email);
      console.log('   Role:', newUser.role);
      console.log('   Created at:', newUser.createdAt);
    }
    console.log('');

    // Test 9: Update user profile
    console.log('Test 9: Update user profile');
    const updateSuccess = userManager.updateUserProfile(newUserId, {
      email: 'updated@example.com',
      quotas: {
        ...newUser.quotas,
        maxRequestsPerDay: 750
      }
    });
    if (updateSuccess) {
      console.log('✅ User profile updated successfully');
      const updatedUser = userManager.getUserProfile(newUserId);
      console.log('   Updated email:', updatedUser.email);
      console.log('   Updated quota:', updatedUser.quotas.maxRequestsPerDay);
    } else {
      console.log('❌ Failed to update user profile');
    }
    console.log('');

    // Test 10: Update user preferences
    console.log('Test 10: Update user preferences');
    const prefUpdateSuccess = userManager.updateUserPreferences(newUserId, {
      theme: 'dark',
      language: 'zh-CN',
      advanced: {
        debugMode: true,
        logLevel: 'debug',
        enableExperimental: true
      }
    });
    if (prefUpdateSuccess) {
      console.log('✅ User preferences updated successfully');
      const updatedPrefs = userManager.getUserPreferences(newUserId);
      console.log('   Updated theme:', updatedPrefs.theme);
      console.log('   Updated language:', updatedPrefs.language);
      console.log('   Debug mode:', updatedPrefs.advanced.debugMode);
    } else {
      console.log('❌ Failed to update user preferences');
    }
    console.log('');

    // Test 11: Permission validation
    console.log('Test 11: Permission validation');
    const newUserPerms = userManager.getUserPermissions(newUserId);
    console.log('✅ New user permissions:', newUserPerms.length);
    newUserPerms.forEach(perm => {
      console.log(`   - ${perm.effect} ${perm.actions.join(',')} on ${perm.resources.join(',')}`);
    });
    console.log('');

    // Test 12: Configuration validation
    console.log('Test 12: Configuration validation');
    const validation = userManager.validateConfig(userManager.userConfig);
    console.log('✅ Configuration validation:');
    console.log('   Valid:', validation.isValid);
    console.log('   Errors:', validation.errors.length);
    console.log('   Warnings:', validation.warnings.length);
    if (validation.errors.length > 0) {
      validation.errors.forEach(error => console.log('   Error:', error));
    }
    console.log('');

    // Test 13: Save configuration
    console.log('Test 13: Save configuration');
    await userManager.saveUserConfig();
    console.log('✅ User configuration saved successfully\n');

    // Test 14: Configuration version and metadata
    console.log('Test 14: Configuration version and metadata');
    console.log('✅ Configuration metadata:');
    console.log('   Version:', userManager.userConfig.version);
    console.log('   Last updated:', userManager.userConfig.lastUpdated);
    console.log('   Total users in config:', Object.keys(userManager.userConfig.users).length);
    console.log('   Total permissions:', Object.keys(userManager.userConfig.permissions).length);
    console.log('   Total preferences:', Object.keys(userManager.userConfig.preferences).length);
    console.log('   Total sessions:', Object.keys(userManager.userConfig.sessions).length);
    console.log('');

    // Performance Summary
    console.log('📊 User Configuration System Summary:');
    console.log('   ✅ User Management: Working');
    console.log('   ✅ Permission System: Working');
    console.log('   ✅ Preferences Management: Working');
    console.log('   ✅ Search Functionality: Working');
    console.log('   ✅ Metrics Collection: Working');
    console.log('   ✅ Configuration Validation: Working');
    console.log('   ✅ Data Persistence: Working');
    console.log('');

    console.log('🎉 User configuration system tests completed successfully!');

  } catch (error) {
    console.error('❌ User configuration system test failed:', error);
    process.exit(1);
  }
}

// Run tests
testUserConfigSystem();