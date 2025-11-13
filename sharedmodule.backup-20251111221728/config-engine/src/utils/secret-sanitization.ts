/**
 * RouteCodex Secret Sanitization Utility
 * Detects and sanitizes sensitive information in configurations and logs
 */

import type { JsonValue } from '../types/config-types.js';

// Secret detection patterns
export const SECRET_PATTERNS = {
  // API Key patterns
  apiKey: [
    /sk-[a-zA-Z0-9-]{10,}/g,  // OpenAI API keys (reduced min length for testing)
    /pk-[a-zA-Z0-9-]{10,}/g,  // OpenAI project keys (reduced min length for testing)
    /ak-[a-zA-Z0-9-]{10,}/g,  // Generic API keys (reduced min length for testing)
  ],

  // Token patterns
  token: [
    /Bearer\s+[a-zA-Z0-9_\-\.=]{32,}/gi,  // Bearer tokens
    /OAuth\s+[a-zA-Z0-9_\-\.=]{32,}/gi,   // OAuth tokens
    /ghp_[a-zA-Z0-9]{36,}/gi,             // GitHub tokens
    /glpat-[a-zA-Z0-9_\-]{20,}/gi,        // GitLab tokens
  ],

  // URL patterns with credentials
  urlWithCredentials: [
    /https?:\/\/[^:]+:[^@]+@[^\s]+/g,  // URLs with username:password (entire URL)
  ],

  // Password patterns
  password: [
    /"password":\s*"[^"]+"/gi,    // Password fields in JSON
    /'password':\s*'[^']+'/gi,    // Password fields in JSON (single quotes)
    /password\s*=\s*[^,\s]+/gi,   // Password assignments
  ],

  // Secret patterns by key name
  secretKeys: [
    /"?(apiKey|api_key|secret|token|password|auth|credential)"?\s*[:=]\s*["']?[^"'\s,}]{8,}/gi,
  ],

  // Environment variable patterns (exclude from sanitization)
  environmentVariables: [
    /\$\{[A-Z_][A-Z0-9_]*\}/g,  // Environment variable placeholders like ${API_KEY}
  ],

  // Generic long string pattern (only if no other patterns match) - VERY conservative
  genericLongString: [
    /[a-fA-F0-9]{32,}/g,     // Only pure hex strings (very likely keys) - 32+ chars
  ],
};

// Sanitization replacement
export const SANITIZATION_REPLACEMENT = '***REDACTED***';

// Fields that commonly contain sensitive data
export const SENSITIVE_FIELDS = new Set([
  'apiKey', 'apikey', 'api_key', 'apiKeys', 'secret', 'token', 'password', 'auth', 'credentials',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'access', 'refresh',
  'clientSecret', 'client_secret', 'webhookSecret', 'webhook_secret',
  'privateKey', 'private_key', 'signingKey', 'signing_key',
  'databasePassword', 'db_password', 'connectionString',
  'bearer', 'bearerToken', 'bearer_token',
]);

/**
 * Detects if a value is an environment variable placeholder
 */
export function isEnvironmentVariable(value: string): boolean {
  for (const pattern of SECRET_PATTERNS.environmentVariables) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

/**
 * Detects if a value contains sensitive information
 */
export function containsSensitiveData(value: any): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  // First check if it's an environment variable pattern (exclude from sanitization)
  if (isEnvironmentVariable(value)) {
    return false; // Don't sanitize environment variables
  }

  // Check all secret patterns
  for (const patternCategory of Object.values(SECRET_PATTERNS)) {
    // Skip environment variables category as we already handled it
    if (patternCategory === SECRET_PATTERNS.environmentVariables) continue;

    for (const pattern of patternCategory) {
      // Reset regex state to avoid issues with global flag
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return true;
      }
      // Reset regex state after test
      pattern.lastIndex = 0;
    }
  }

  return false;
}

/**
 * Sanitizes a string value by replacing sensitive information
 */
export function sanitizeString(value: string): string {
  let sanitized = value;

  // Apply API key patterns (replace entire match)
  SECRET_PATTERNS.apiKey.forEach(pattern => {
    sanitized = sanitized.replace(pattern, SANITIZATION_REPLACEMENT);
  });

  // Apply token patterns (replace entire match)
  SECRET_PATTERNS.token.forEach(pattern => {
    sanitized = sanitized.replace(pattern, SANITIZATION_REPLACEMENT);
  });

  // Apply URL with credentials patterns (replace entire URL)
  SECRET_PATTERNS.urlWithCredentials.forEach(pattern => {
    sanitized = sanitized.replace(pattern, SANITIZATION_REPLACEMENT);
  });

  // Apply password patterns (replace entire match including field name)
  SECRET_PATTERNS.password.forEach(pattern => {
    sanitized = sanitized.replace(pattern, (match) => {
      // For password patterns, replace just the value part
      return match.replace(/"[^"]+"|'[^']+'|\S+$/, SANITIZATION_REPLACEMENT);
    });
  });

  // Apply secret key patterns (replace entire match including field name)
  SECRET_PATTERNS.secretKeys.forEach(pattern => {
    sanitized = sanitized.replace(pattern, (_match) => {
      // For secret keys, replace the entire match for complete sanitization
      return SANITIZATION_REPLACEMENT;
    });
  });

  // Note: Environment variable patterns are intentionally NOT applied here
  // We want to preserve environment variable placeholders for expansion

  // Apply generic pattern last (only for standalone long strings)
  // Note: This is potentially dangerous and should be used cautiously
  if (SECRET_PATTERNS.genericLongString) {
    SECRET_PATTERNS.genericLongString.forEach(pattern => {
      // Only apply if no other patterns have matched and it looks like a real key
      sanitized = sanitized.replace(pattern, (match) => {
        // Additional heuristics to avoid false positives - be VERY conservative
        // Only replace pure hex strings that are at least 40 chars (actual API key lengths)
        if (match.length >= 40 && /^[a-fA-F0-9]+$/.test(match)) {
          return SANITIZATION_REPLACEMENT;
        }
        return match;
      });
    });
  }

  return sanitized;
}

/**
 * Recursively sanitizes a JSON object
 */
export function sanitizeObject(obj: JsonValue, path: string = ''): JsonValue {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    // Handle arrays: sanitize each element individually
    return obj.map((item, index) => {
      if (typeof item === 'string' && containsSensitiveData(item)) {
        return sanitizeString(item);
      } else if (typeof item === 'object' && item !== null) {
        return sanitizeObject(item, `${path}[${index}]`);
      }
      return item;
    });
  }

  const result: any = {};

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;

    // Check if the key indicates sensitive data
    const keyLower = key.toLowerCase();
    if (shouldSanitizeField(key, value)) {
      // For container objects (objects with nested fields), recursively sanitize instead of replacing entirely
      if (typeof value === 'string') {
        // Special handling for apiKey fields: redact unless it's an environment variable placeholder
        if (keyLower === 'apikey') {
          if (isEnvironmentVariable(value)) {
            result[key] = value; // Keep environment variable placeholders for expansion
          } else {
            result[key] = SANITIZATION_REPLACEMENT; // Always redact apiKey fields unless they're environment variables
          }
        }
        // For bearer, password, access, and refresh fields, always redact regardless of content
        // For other sensitive fields, only redact if they contain sensitive patterns
        else if (keyLower === 'bearer' || keyLower === 'password' || keyLower === 'access' || keyLower === 'refresh' || containsSensitiveData(value)) {
          result[key] = SANITIZATION_REPLACEMENT;
        } else {
          result[key] = value; // Keep non-sensitive values in other sensitive fields
        }
      } else if (Array.isArray(value)) {
        // For arrays in sensitive fields, check if any element is sensitive
        // If the field is sensitive and contains any sensitive data, redact entire array
        // Otherwise, sanitize each element individually
        const hasSensitiveContent = value.some(item =>
          (typeof item === 'string' && containsSensitiveData(item)) ||
          (typeof item === 'object' && item !== null && shouldSanitizeField(key, item))
        );

        if (shouldSanitizeField(key, value) && hasSensitiveContent) {
          result[key] = value.map(() => SANITIZATION_REPLACEMENT);
        } else {
          // Sanitize each element in the array
          result[key] = value.map(item => {
            if (typeof item === 'string' && containsSensitiveData(item)) {
              return sanitizeString(item);
            } else if (typeof item === 'object' && item !== null) {
              return sanitizeObject(item, currentPath);
            }
            return item;
          });
        }
      } else if (typeof value === 'object' && value !== null) {
        // For objects, recursively sanitize instead of completely replacing
        // This preserves structure while sanitizing nested sensitive fields
        result[key] = sanitizeObject(value, currentPath);
      } else {
        result[key] = SANITIZATION_REPLACEMENT;
      }
    } else if (typeof value === 'string') {
      // Check string values for sensitive patterns
      if (containsSensitiveData(value)) {
        result[key] = sanitizeString(value);
      } else {
        result[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      // Recursively sanitize nested objects
      result[key] = sanitizeObject(value, currentPath);
    } else {
      // Pass through primitive values
      result[key] = value;
    }
  }

  return result;
}

/**
 * Creates a safe version of configuration for logging/output
 */
export function createSafeConfig(config: JsonValue): JsonValue {
  return sanitizeObject(config);
}

/**
 * Sanitizes an error message to prevent leaking sensitive data
 */
export function sanitizeError(error: any): any {
  if (typeof error === 'string') {
    return sanitizeString(error);
  }

  if (error && typeof error === 'object') {
    const sanitized: any = {};

    for (const [key, value] of Object.entries(error)) {
      if (key === 'message' && typeof value === 'string') {
        sanitized[key] = sanitizeString(value);
      } else if (key === 'config' && typeof value === 'object') {
        sanitized[key] = createSafeConfig(value as JsonValue);
      } else if (typeof value === 'string') {
        sanitized[key] = sanitizeString(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

/**
 * Checks if a configuration field should be sanitized
 */
export function shouldSanitizeField(key: string, value: any): boolean {
  // Check key-based heuristics
  const keyLower = key.toLowerCase();

  // Check against sensitive fields set
  if (SENSITIVE_FIELDS.has(keyLower)) {
    return true;
  }

  // Check for sensitive keywords in field name (more specific matching)
  const sensitiveKeywords = [
    'secret', 'password', 'token', 'auth', 'credential', 'key', 'api',
    'accesstoken', 'refreshtoken', 'clientsecret', 'webhooksecret',
    'privatekey', 'signingkey', 'databasepassword', 'connectionstring'
  ];
  if (sensitiveKeywords.some(keyword => {
    // Match whole words or word boundaries to avoid partial matches like "secretary"
    const regex = new RegExp(`\\b${keyword}\\b`);
    return regex.test(keyLower);
  })) {
    return true;
  }

  // Check value-based heuristics for strings
  if (typeof value === 'string') {
    return containsSensitiveData(value);
  }

  // Check arrays of strings for sensitive data
  if (Array.isArray(value)) {
    return value.some(item => typeof item === 'string' && containsSensitiveData(item));
  }

  return false;
}

/**
 * Masks sensitive data for display purposes
 */
export function maskSensitiveData(data: string, visibleChars: number = 4): string {
  if (data.length <= visibleChars + 8) {
    return SANITIZATION_REPLACEMENT;
  }

  const prefix = data.substring(0, visibleChars);
  const suffix = data.substring(data.length - visibleChars);
  return `${prefix}...${suffix}`;
}