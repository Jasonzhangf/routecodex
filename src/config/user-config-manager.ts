/**
 * User Configuration Manager
 * Manages user profiles, permissions, preferences, and authentication
 */

import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import type {
  UserConfig,
  UserProfile,
  Permission,
  UserPreferences,
  UserSession,
  UserAuthConfig,
  UserManagerConfig,
  UserQuotas,
  UserSearchOptions,
  UserSearchResult,
  UserMetrics,
  UserConfigValidationResult,
  IUserConfigManager
} from './user-config-types.js';
// import { BaseModule } from '../core/base-module.js';
// import { ErrorHandlingCenter } from '../core/error-handling-center.js';

/**
 * User Configuration Manager Implementation
 */
export class UserConfigManager extends EventEmitter implements IUserConfigManager {
  private userConfig: UserConfig;
  private configPath: string;
  // private errorHandling: ErrorHandlingCenter;
  private isLoaded: boolean = false;
  private watchers: any[] = [];

  constructor(configPath: string = './config/users.json') {
    super();

    this.configPath = configPath;
    // this.errorHandling = new ErrorHandlingCenter();
    this.userConfig = this.getDefaultUserConfig();
  }

  /**
   * Load user configuration from file
   */
  async loadUserConfig(): Promise<UserConfig> {
    try {
      console.log(`📂 Loading user configuration from ${this.configPath}`);

      // Ensure config directory exists
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });

      // Try to load existing configuration
      let configData: any;
      try {
        const configContent = await fs.readFile(this.configPath, 'utf-8');
        configData = JSON.parse(configContent);
      } catch (error) {
        console.log('📝 No existing user config found, creating default configuration');
        configData = null;
      }

      // Validate and merge configuration
      const validation = this.validateConfig(configData);
      if (!validation.isValid) {
        console.warn('⚠️  User configuration validation failed, using defaults');
        validation.errors.forEach(error => console.warn(`   Error: ${error}`));
        this.userConfig = this.getDefaultUserConfig();
      } else {
        this.userConfig = validation.config!;
      }

      // Update configuration metadata
      this.userConfig.lastUpdated = new Date().toISOString();
      this.userConfig.version = '1.0.0';

      this.isLoaded = true;
      this.emit('configLoaded', this.userConfig);

      console.log('✅ User configuration loaded successfully');
      return this.userConfig;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'loadUserConfig', error as Error);
      console.error('❌ Failed to load user configuration:', error);
      throw error;
    }
  }

  /**
   * Save user configuration to file
   */
  async saveUserConfig(): Promise<void> {
    try {
      console.log(`💾 Saving user configuration to ${this.configPath}`);

      // Update timestamp
      this.userConfig.lastUpdated = new Date().toISOString();

      // Ensure directory exists
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });

      // Save configuration with pretty formatting
      const configJson = JSON.stringify(this.userConfig, null, 2);
      await fs.writeFile(this.configPath, configJson, 'utf-8');

      // Create backup
      const backupPath = `${this.configPath}.backup`;
      await fs.writeFile(backupPath, configJson, 'utf-8');

      this.emit('configSaved', this.userConfig);
      console.log('✅ User configuration saved successfully');

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'saveUserConfig', error as Error);
      console.error('❌ Failed to save user configuration:', error);
      throw error;
    }
  }

  /**
   * Get user profile by ID
   */
  getUserProfile(userId: string): UserProfile | undefined {
    return this.userConfig.users[userId];
  }

  /**
   * Update user profile
   */
  updateUserProfile(userId: string, updates: Partial<UserProfile>): boolean {
    try {
      const existingUser = this.userConfig.users[userId];
      if (!existingUser) {
        console.warn(`⚠️  User ${userId} not found for update`);
        return false;
      }

      // Validate updates
      const validation = this.validateUserProfile(updates);
      if (!validation.isValid) {
        console.warn('⚠️  User profile validation failed:', validation.errors);
        return false;
      }

      // Apply updates
      this.userConfig.users[userId] = {
        ...existingUser,
        ...updates,
        id: userId, // Prevent ID changes
        createdAt: existingUser.createdAt // Preserve creation time
      };

      this.emit('userUpdated', { userId, updates, timestamp: new Date().toISOString() });
      return true;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'updateUserProfile', error as Error);
      return false;
    }
  }

  /**
   * Create new user profile
   */
  createUserProfile(userData: Omit<UserProfile, 'id' | 'createdAt'>): string {
    try {
      const userId = this.generateUserId();
      const userProfile: UserProfile = {
        ...userData,
        id: userId,
        createdAt: new Date().toISOString(),
        enabled: userData.enabled ?? true
      };

      // Validate new user
      const validation = this.validateUserProfile(userProfile);
      if (!validation.isValid) {
        throw new Error(`User validation failed: ${validation.errors.join(', ')}`);
      }

      this.userConfig.users[userId] = userProfile;

      // Create default permissions
      this.createUserDefaultPermissions(userId, userData.role);

      // Create default preferences
      this.createUserDefaultPreferences(userId);

      this.emit('userCreated', { userId, userData: userProfile, timestamp: new Date().toISOString() });
      console.log(`✅ User created: ${userId} (${userData.username})`);

      return userId;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'createUserProfile', error as Error);
      throw error;
    }
  }

  /**
   * Delete user profile
   */
  deleteUserProfile(userId: string): boolean {
    try {
      if (!this.userConfig.users[userId]) {
        console.warn(`⚠️  User ${userId} not found for deletion`);
        return false;
      }

      // Remove user
      delete this.userConfig.users[userId];

      // Remove permissions
      delete this.userConfig.permissions[userId];

      // Remove preferences
      delete this.userConfig.preferences[userId];

      // Remove sessions
      Object.keys(this.userConfig.sessions)
        .filter(sessionId => this.userConfig.sessions[sessionId].userId === userId)
        .forEach(sessionId => delete this.userConfig.sessions[sessionId]);

      this.emit('userDeleted', { userId, timestamp: new Date().toISOString() });
      console.log(`✅ User deleted: ${userId}`);
      return true;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'deleteUserProfile', error as Error);
      return false;
    }
  }

  /**
   * Get user permissions
   */
  getUserPermissions(userId: string): Permission[] {
    const userPermissions = this.userConfig.permissions[userId];
    if (!userPermissions) {
      return [];
    }
    return Array.isArray(userPermissions) ? userPermissions : [userPermissions];
  }

  /**
   * Update user permissions
   */
  updateUserPermissions(userId: string, permissions: Permission[]): boolean {
    try {
      if (!this.userConfig.users[userId]) {
        console.warn(`⚠️  User ${userId} not found for permission update`);
        return false;
      }

      // Validate permissions
      for (const permission of permissions) {
        const validation = this.validatePermission(permission);
        if (!validation.isValid) {
          console.warn(`⚠️  Permission validation failed: ${validation.errors.join(', ')}`);
          return false;
        }
      }

      this.userConfig.permissions[userId] = permissions;
      this.emit('permissionsUpdated', { userId, permissions, timestamp: new Date().toISOString() });
      return true;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'updateUserPermissions', error as Error);
      return false;
    }
  }

  /**
   * Get user preferences
   */
  getUserPreferences(userId: string): UserPreferences | undefined {
    return this.userConfig.preferences[userId];
  }

  /**
   * Update user preferences
   */
  updateUserPreferences(userId: string, preferences: Partial<UserPreferences>): boolean {
    try {
      const existingPrefs = this.userConfig.preferences[userId];
      if (!existingPrefs) {
        console.warn(`⚠️  User ${userId} not found for preference update`);
        return false;
      }

      this.userConfig.preferences[userId] = {
        ...existingPrefs,
        ...preferences,
        userId: userId // Prevent ID changes
      };

      this.emit('preferencesUpdated', { userId, preferences, timestamp: new Date().toISOString() });
      return true;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'updateUserPreferences', error as Error);
      return false;
    }
  }

  /**
   * Check user permission for resource and action
   */
  checkPermission(userId: string, resource: string, action: string): boolean {
    try {
      const user = this.userConfig.users[userId];
      if (!user || !user.enabled) {
        return false;
      }

      // Admin users have all permissions
      if (user.role === 'admin') {
        return true;
      }

      const permissions = this.getUserPermissions(userId);

      // Check each permission
      for (const permission of permissions) {
        // Check if resource matches (support wildcards)
        const resourceMatches = permission.resources.some(r =>
          r === '*' || r === resource || this.matchPattern(r, resource)
        );

        // Check if action matches (support wildcards)
        const actionMatches = permission.actions.some(a =>
          a === '*' || a === action || this.matchPattern(a, action)
        );

        if (resourceMatches && actionMatches) {
          // Check conditions if any
          if (permission.conditions) {
            const context = this.getPermissionContext(userId);
            if (this.evaluateConditions(permission.conditions, context)) {
              return permission.effect === 'allow';
            }
          } else {
            return permission.effect === 'allow';
          }
        }
      }

      // Default deny
      return false;

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'checkPermission', error as Error);
      return false;
    }
  }

  /**
   * Search users with filters
   */
  async searchUsers(options: UserSearchOptions): Promise<UserSearchResult> {
    try {
      let users = Object.values(this.userConfig.users);

      // Apply filters
      if (options.enabled !== undefined) {
        users = users.filter(user => user.enabled === options.enabled);
      }

      if (options.role) {
        users = users.filter(user => user.role === options.role);
      }

      if (options.query) {
        const query = options.query.toLowerCase();
        users = users.filter(user =>
          user.username.toLowerCase().includes(query) ||
          user.email.toLowerCase().includes(query) ||
          user.id.toLowerCase().includes(query)
        );
      }

      if (options.createdAfter) {
        const afterDate = new Date(options.createdAfter);
        users = users.filter(user => new Date(user.createdAt) > afterDate);
      }

      if (options.createdBefore) {
        const beforeDate = new Date(options.createdBefore);
        users = users.filter(user => new Date(user.createdAt) < beforeDate);
      }

      if (options.lastLoginAfter) {
        const afterDate = new Date(options.lastLoginAfter);
        users = users.filter(user =>
          user.lastLogin && new Date(user.lastLogin) > afterDate
        );
      }

      // Sort results
      if (options.sortBy) {
        users.sort((a, b) => {
          let aValue: any, bValue: any;

          switch (options.sortBy) {
            case 'createdAt':
              aValue = new Date(a.createdAt);
              bValue = new Date(b.createdAt);
              break;
            case 'lastLogin':
              aValue = a.lastLogin ? new Date(a.lastLogin) : new Date(0);
              bValue = b.lastLogin ? new Date(b.lastLogin) : new Date(0);
              break;
            case 'username':
              aValue = a.username;
              bValue = b.username;
              break;
            default:
              aValue = a.username;
              bValue = b.username;
          }

          if (aValue < bValue) return options.sortOrder === 'asc' ? -1 : 1;
          if (aValue > bValue) return options.sortOrder === 'asc' ? 1 : -1;
          return 0;
        });
      }

      // Apply pagination
      const offset = options.offset || 0;
      const limit = options.limit || 20;
      const paginatedUsers = users.slice(offset, offset + limit);

      return {
        users: paginatedUsers,
        total: users.length,
        limit,
        offset,
        hasMore: offset + limit < users.length
      };

    } catch (error) {
      // this.errorHandling.handleError('UserConfigManager', 'searchUsers', error as Error);
      throw error;
    }
  }

  /**
   * Get user metrics and statistics
   */
  getUserMetrics(): UserMetrics {
    const users = Object.values(this.userConfig.users);
    const sessions = Object.values(this.userConfig.sessions);

    const activeUsers = users.filter(user => user.enabled).length;
    const activeSessions = sessions.filter(session => session.isActive).length;

    // Calculate average session duration
    const now = new Date();
    const totalDuration = sessions.reduce((sum, session) => {
      const start = new Date(session.createdAt);
      const end = session.isActive ? now : new Date(session.lastAccessed);
      return sum + (end.getTime() - start.getTime());
    }, 0);

    const averageSessionDuration = sessions.length > 0 ? totalDuration / sessions.length : 0;

    return {
      totalUsers: users.length,
      activeUsers,
      totalSessions: sessions.length,
      averageSessionDuration,
      requestsPerUser: {}, // Would be populated by request tracking
      topProviders: [], // Would be populated by provider usage tracking
      systemLoad: {
        concurrentRequests: 0, // Would be populated by system monitoring
        memoryUsage: process.memoryUsage().heapUsed,
        cpuUsage: 0 // Would be populated by system monitoring
      }
    };
  }

  /**
   * Validate configuration structure
   */
  validateConfig(config: any): UserConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config || typeof config !== 'object') {
      errors.push('Configuration must be an object');
      return { isValid: false, errors, warnings };
    }

    // Validate required sections
    const requiredSections = ['users', 'permissions', 'preferences', 'sessions', 'auth', 'manager'];
    for (const section of requiredSections) {
      if (!config[section]) {
        errors.push(`Missing required section: ${section}`);
      }
    }

    // Validate users
    if (config.users) {
      if (typeof config.users !== 'object') {
        errors.push('Users must be an object');
      } else {
        for (const [userId, user] of Object.entries(config.users)) {
          const userValidation = this.validateUserProfile(user);
          errors.push(...userValidation.errors.map(e => `User ${userId}: ${e}`));
          warnings.push(...userValidation.warnings.map(w => `User ${userId}: ${w}`));
        }
      }
    }

    const isValid = errors.length === 0 && this.isValidConfigStructure(config);
    return {
      isValid,
      errors,
      warnings,
      config: isValid ? config : undefined
    };
  }

  /**
   * Get default user configuration
   */
  private getDefaultUserConfig(): UserConfig {
    const defaultQuotas: UserQuotas = {
      maxRequestsPerDay: 1000,
      maxTokensPerRequest: 4096,
      maxConcurrentRequests: 5,
      maxProviders: 3,
      maxFiles: 100,
      maxStorageMB: 1024
    };

    const defaultAuth: UserAuthConfig = {
      enabled: true,
      type: 'jwt',
      jwt: {
        secret: 'default-secret-change-in-production',
        expiresIn: '24h',
        issuer: 'routecodex',
        audience: 'routecodex-users',
        algorithm: 'HS256'
      },
      sessionTimeout: 3600000, // 1 hour
      maxSessionsPerUser: 5
    };

    const defaultManager: UserManagerConfig = {
      enabled: true,
      configPath: './config/users.json',
      authMethod: 'jwt',
      sessionTimeout: 3600000,
      enableUserRegistration: false,
      requireEmailVerification: false,
      defaultUserQuotas: defaultQuotas,
      maxUsers: 100,
      enablePasswordPolicy: true,
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireNumbers: true,
        requireSpecialChars: false
      }
    };

    return {
      users: {},
      permissions: {},
      preferences: {},
      sessions: {},
      auth: defaultAuth,
      manager: defaultManager,
      version: '1.0.0',
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Generate unique user ID
   */
  private generateUserId(): string {
    return crypto.randomUUID();
  }

  /**
   * Create default permissions for new user
   */
  private createUserDefaultPermissions(userId: string, role: string): void {
    const defaultPermissions: Permission[] = [];

    switch (role) {
      case 'admin':
        defaultPermissions.push({
          userId,
          resources: ['*'],
          actions: ['*'],
          effect: 'allow',
          priority: 100
        });
        break;

      case 'user':
        defaultPermissions.push({
          userId,
          resources: ['api/*', 'models/*', 'providers/*'],
          actions: ['read', 'write'],
          effect: 'allow',
          priority: 50
        });
        break;

      case 'guest':
        defaultPermissions.push({
          userId,
          resources: ['api/public/*', 'models/public/*'],
          actions: ['read'],
          effect: 'allow',
          priority: 10
        });
        break;
    }

    this.userConfig.permissions[userId] = defaultPermissions;
  }

  /**
   * Create default preferences for new user
   */
  private createUserDefaultPreferences(userId: string): void {
    const defaultPreferences: UserPreferences = {
      userId,
      notifications: {
        enabled: true,
        types: ['system', 'security'],
        email: false,
        push: false
      },
      advanced: {
        debugMode: false,
        logLevel: 'info',
        enableExperimental: false
      },
      ui: {
        sidebarCollapsed: false,
        showMetrics: true,
        autoSave: true
      }
    };

    this.userConfig.preferences[userId] = defaultPreferences;
  }

  /**
   * Validate user profile
   */
  private validateUserProfile(user: any): UserConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!user.username || typeof user.username !== 'string') {
      errors.push('Username is required and must be a string');
    }

    if (!user.email || typeof user.email !== 'string' || !user.email.includes('@')) {
      errors.push('Valid email is required');
    }

    if (!['admin', 'user', 'guest'].includes(user.role)) {
      errors.push('Role must be admin, user, or guest');
    }

    if (typeof user.enabled !== 'boolean') {
      errors.push('Enabled must be a boolean');
    }

    if (!user.quotas || typeof user.quotas !== 'object') {
      errors.push('Quotas are required and must be an object');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate permission
   */
  private validatePermission(permission: any): UserConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!permission.resources || !Array.isArray(permission.resources)) {
      errors.push('Resources must be an array');
    }

    if (!permission.actions || !Array.isArray(permission.actions)) {
      errors.push('Actions must be an array');
    }

    if (!['allow', 'deny'].includes(permission.effect)) {
      errors.push('Effect must be allow or deny');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Check if configuration structure is valid (basic structure check)
   */
  private isValidConfigStructure(config: any): boolean {
    return config &&
           typeof config === 'object' &&
           config.users && typeof config.users === 'object' &&
           config.permissions && typeof config.permissions === 'object' &&
           config.preferences && typeof config.preferences === 'object' &&
           config.sessions && typeof config.sessions === 'object' &&
           config.auth && typeof config.auth === 'object' &&
           config.manager && typeof config.manager === 'object';
  }

  /**
   * Match pattern with wildcards
   */
  private matchPattern(pattern: string, str: string): boolean {
    const regexPattern = pattern.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(str);
  }

  /**
   * Get permission evaluation context
   */
  private getPermissionContext(userId: string): Record<string, any> {
    const user = this.userConfig.users[userId];
    return {
      userId,
      userRole: user?.role,
      userEnabled: user?.enabled,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Evaluate permission conditions
   */
  private evaluateConditions(conditions: Record<string, any>, context: Record<string, any>): boolean {
    try {
      // Simple condition evaluation (in production, use a proper expression evaluator)
      for (const [key, value] of Object.entries(conditions)) {
        if (context[key] !== value) {
          return false;
        }
      }
      return true;
    } catch (error) {
      return false;
    }
  }
}