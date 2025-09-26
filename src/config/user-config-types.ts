/**
 * User Configuration Types
 * Type definitions for user management and configuration system
 */

/**
 * User profile information
 */
export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
  enabled: boolean;
  createdAt: string;
  lastLogin?: string;
  apiKeys?: string[];
  quotas: UserQuotas;
  metadata?: Record<string, any>;
}

/**
 * User quota limits
 */
export interface UserQuotas {
  maxRequestsPerDay: number;
  maxTokensPerRequest: number;
  maxConcurrentRequests: number;
  maxProviders: number;
  maxFiles?: number;
  maxStorageMB?: number;
}

/**
 * User permission settings
 */
export interface Permission {
  userId: string;
  resources: string[];
  actions: string[];
  effect: 'allow' | 'deny';
  conditions?: Record<string, any>;
  priority?: number;
}

/**
 * User preferences and settings
 */
export interface UserPreferences {
  userId: string;
  defaultProvider?: string;
  defaultModel?: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  timezone?: string;
  notifications: {
    enabled: boolean;
    types: string[];
    email?: boolean;
    push?: boolean;
  };
  advanced: {
    debugMode: boolean;
    logLevel: 'error' | 'warn' | 'info' | 'debug';
    enableExperimental: boolean;
  };
  ui?: {
    sidebarCollapsed: boolean;
    showMetrics: boolean;
    autoSave: boolean;
  };
}

/**
 * User session information
 */
export interface UserSession {
  id: string;
  userId: string;
  token: string;
  refreshToken?: string;
  expiresAt: string;
  createdAt: string;
  lastAccessed: string;
  ipAddress: string;
  userAgent: string;
  isActive: boolean;
}

/**
 * User authentication configuration
 */
export interface UserAuthConfig {
  enabled: boolean;
  type: 'api-key' | 'jwt' | 'oauth' | 'custom';
  apiKey?: {
    headerName: string;
    prefix: string;
  };
  jwt?: {
    secret: string;
    expiresIn: string;
    issuer: string;
    audience: string;
    algorithm: string;
  };
  oauth?: {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    redirectUri: string;
  };
  sessionTimeout: number;
  maxSessionsPerUser: number;
}

/**
 * User management configuration
 */
export interface UserManagerConfig {
  enabled: boolean;
  configPath: string;
  authMethod: 'jwt' | 'api-key' | 'oauth';
  sessionTimeout: number;
  enableUserRegistration: boolean;
  requireEmailVerification: boolean;
  defaultUserQuotas: UserQuotas;
  maxUsers: number;
  enablePasswordPolicy: boolean;
  passwordPolicy?: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
  };
}

/**
 * Complete user configuration
 */
export interface UserConfig {
  users: Record<string, UserProfile>;
  permissions: Record<string, Permission[]>;
  preferences: Record<string, UserPreferences>;
  sessions: Record<string, UserSession>;
  auth: UserAuthConfig;
  manager: UserManagerConfig;
  version: string;
  lastUpdated: string;
}

/**
 * Default user configuration
 */
export interface DefaultUserConfig {
  users: Record<string, Omit<UserProfile, 'id' | 'createdAt' | 'enabled'>>;
  defaultRole: 'admin' | 'user' | 'guest';
  defaultQuotas: UserQuotas;
  defaultPreferences: Omit<UserPreferences, 'userId'>;
}

/**
 * User management events
 */
export interface UserManagementEvent {
  type: 'user_created' | 'user_updated' | 'user_deleted' | 'user_login' | 'user_logout';
  userId: string;
  timestamp: string;
  data?: any;
}

/**
 * User statistics and metrics
 */
export interface UserMetrics {
  totalUsers: number;
  activeUsers: number;
  totalSessions: number;
  averageSessionDuration: number;
  requestsPerUser: Record<string, number>;
  topProviders: Array<{ provider: string; usage: number }>;
  systemLoad: {
    concurrentRequests: number;
    memoryUsage: number;
    cpuUsage: number;
  };
}

/**
 * User search and filter options
 */
export interface UserSearchOptions {
  query?: string;
  role?: string;
  enabled?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  lastLoginAfter?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'lastLogin' | 'username';
  sortOrder?: 'asc' | 'desc';
}

/**
 * User search result
 */
export interface UserSearchResult {
  users: UserProfile[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Configuration validation result
 */
export interface UserConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  config?: UserConfig;
}

/**
 * User configuration manager interface
 */
export interface IUserConfigManager {
  loadUserConfig(): Promise<UserConfig>;
  saveUserConfig(): Promise<void>;
  getUserProfile(userId: string): UserProfile | undefined;
  updateUserProfile(userId: string, updates: Partial<UserProfile>): boolean;
  createUserProfile(userData: Omit<UserProfile, 'id' | 'createdAt'>): string;
  deleteUserProfile(userId: string): boolean;
  getUserPermissions(userId: string): Permission[];
  updateUserPermissions(userId: string, permissions: Permission[]): boolean;
  getUserPreferences(userId: string): UserPreferences | undefined;
  updateUserPreferences(userId: string, preferences: Partial<UserPreferences>): boolean;
  checkPermission(userId: string, resource: string, action: string): boolean;
  searchUsers(options: UserSearchOptions): Promise<UserSearchResult>;
  getUserMetrics(): UserMetrics;
  validateConfig(config: any): UserConfigValidationResult;
}
