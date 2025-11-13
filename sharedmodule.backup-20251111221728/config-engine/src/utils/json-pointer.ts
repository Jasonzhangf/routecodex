/**
 * RouteCodex JSON Pointer Utilities
 * Comprehensive JSON Pointer implementation for error reporting and path resolution
 */

/**
 * JSON Pointer specification (RFC 6901) implementation
 * Provides utilities for creating, parsing, and resolving JSON Pointers
 */

/**
 * Represents a JSON Pointer as an array of reference tokens
 */
export type JSONPointer = string[];

/**
 * JSON Pointer error with enhanced information
 */
export interface JSONPointerError {
  pointer: string;
  tokens: JSONPointer;
  message: string;
  code: string;
  value?: any;
  expected?: string;
  context?: {
    parent?: any;
    key?: string | number;
    index?: number;
    schemaPath?: string;
  };
}

/**
 * Creates a JSON Pointer string from an array of tokens
 */
export function createJSONPointer(tokens: JSONPointer): string {
  if (tokens.length === 0) {
    return '';
  }

  return '/' + tokens.map(encodeJSONPointerToken).join('/');
}

/**
 * Parses a JSON Pointer string into an array of tokens
 */
export function parseJSONPointer(pointer: string): JSONPointer {
  if (pointer === '') {
    return [];
  }

  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: "${pointer}" must start with "/" or be empty`);
  }

  return pointer.slice(1).split('/').map(decodeJSONPointerToken);
}

/**
 * Encodes a token for use in a JSON Pointer string
 */
export function encodeJSONPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Decodes a token from a JSON Pointer string
 */
export function decodeJSONPointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Resolves a JSON Pointer against a target object
 */
export function resolveJSONPointer(target: any, pointer: string | JSONPointer): any {
  const tokens = Array.isArray(pointer) ? pointer : parseJSONPointer(pointer);
  let current = target;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (current === null || current === undefined) {
      throw new JSONPointerResolutionError(
        `Cannot resolve token "${token}" at index ${i} - target is null or undefined`,
        createJSONPointer(tokens.slice(0, i + 1)),
        tokens.slice(0, i + 1)
      );
    }

    if (typeof current !== 'object') {
      throw new JSONPointerResolutionError(
        `Cannot resolve token "${token}" at index ${i} - parent is not an object`,
        createJSONPointer(tokens.slice(0, i)),
        tokens.slice(0, i)
      );
    }

    if (Array.isArray(current)) {
      const index = parseInt(token, 10);
      if (isNaN(index) || index < 0 || index >= current.length) {
        throw new JSONPointerResolutionError(
          `Invalid array index "${token}" at position ${i}`,
          createJSONPointer(tokens.slice(0, i + 1)),
          tokens.slice(0, i + 1)
        );
      }
      current = current[index];
    } else {
      current = current[token];
    }
  }

  return current;
}

/**
 * Creates a JSON Pointer from a Zod error path
 */
export function createJSONPointerFromZodPath(zodPath: (string | number)[]): string {
  return createJSONPointer(zodPath.map(String));
}

/**
 * Creates a JSON Pointer from an Ajv error path
 */
export function createJSONPointerFromAjvError(ajvError: any): string {
  // Ajv provides instancePath which is already a JSON Pointer string
  if (ajvError.instancePath) {
    return ajvError.instancePath;
  }

  // Fallback to schemaPath if instancePath is not available
  if (ajvError.schemaPath) {
    // Convert schema path (e.g., "#/properties/virtualrouter") to instance path
    return ajvError.schemaPath
      .replace(/^#\//, '/')
      .replace(/\/properties\//g, '/')
      .replace(/\/items\//g, '/')
      .replace(/\/additionalProperties/g, '');
  }

  return '';
}

/**
 * Enhanced error reporting with JSON Pointer context
 */
export function createEnhancedJSONPointerError(
  baseError: {
    code: string;
    message: string;
    path?: string;
    value?: any;
    expected?: string;
  },
  targetObject?: any
): JSONPointerError {
  const path = baseError.path || '';
  const tokens = parseJSONPointer(path);

  const error: JSONPointerError = {
    pointer: path,
    tokens,
    message: baseError.message,
    code: baseError.code,
    value: baseError.value,
    expected: baseError.expected,
  };

  // Add context if target object is provided
  if (targetObject && path) {
    try {
      const parentPath = tokens.length > 1 ? createJSONPointer(tokens.slice(0, -1)) : '';
      const parent = parentPath ? resolveJSONPointer(targetObject, parentPath) : targetObject;
      const key = tokens[tokens.length - 1];

      error.context = {
        parent,
        key,
        index: Array.isArray(parent) && typeof key === 'number' ? key : undefined,
      };
    } catch (resolutionError) {
      // If resolution fails, we still provide basic context
      error.context = {
        schemaPath: path,
      };
    }
  }

  return error;
}

/**
 * Formats a JSON Pointer error for human-readable output
 */
export function formatJSONPointerError(error: JSONPointerError): string {
  const location = error.pointer || 'root';
  const contextInfo = [];

  if (error.context) {
    if (error.context.parent !== undefined) {
      const parentType = Array.isArray(error.context.parent) ? 'array' : 'object';
      const parentPreview = JSON.stringify(error.context.parent).slice(0, 50);
      contextInfo.push(`parent ${parentType}: ${parentPreview}${parentPreview.length >= 50 ? '...' : ''}`);
    }

    if (error.context.key !== undefined) {
      contextInfo.push(`key: "${error.context.key}"`);
    }

    if (error.context.index !== undefined) {
      contextInfo.push(`index: ${error.context.index}`);
    }
  }

  let message = `${error.code}: ${error.message} at "${location}"`;

  if (contextInfo.length > 0) {
    message += ` (${contextInfo.join(', ')})`;
  }

  if (error.expected) {
    message += ` - Expected: ${error.expected}`;
  }

  return message;
}

/**
 * Generates multiple error formats for different use cases
 */
export function createMultiFormatError(
  baseError: {
    code: string;
    message: string;
    path?: string;
    value?: any;
    expected?: string;
  },
  targetObject?: any
): {
  jsonPointer: string;
  dotNotation: string;
  bracketNotation: string;
  humanReadable: string;
  error: JSONPointerError;
} {
  const enhancedError = createEnhancedJSONPointerError(baseError, targetObject);

  // Convert JSON Pointer to dot notation
  const dotNotation = enhancedError.tokens
    .map(token => token.replace(/\./g, '\\.'))
    .join('.');

  // Convert JSON Pointer to bracket notation
  const bracketNotation = enhancedError.tokens
    .map(token => isNaN(Number(token)) ? `["${token.replace(/"/g, '\\"')}"]` : `[${token}]`)
    .join('');

  return {
    jsonPointer: enhancedError.pointer,
    dotNotation: dotNotation || '.',
    bracketNotation: bracketNotation,
    humanReadable: formatJSONPointerError(enhancedError),
    error: enhancedError,
  };
}

/**
 * Validates if a string is a valid JSON Pointer
 */
export function isValidJSONPointer(pointer: string): boolean {
  try {
    parseJSONPointer(pointer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a JSON Pointer (removes trailing slashes, handles empty paths)
 */
export function normalizeJSONPointer(pointer: string): string {
  if (pointer === '') {
    return '';
  }

  // Remove trailing slash unless it's the root
  let normalized = pointer.replace(/\/$/, '');

  // Ensure it starts with exactly one slash
  normalized = normalized.replace(/^\/+/, '/');

  return normalized;
}

/**
 * JSON Pointer resolution error
 */
export class JSONPointerResolutionError extends Error {
  public readonly pointer: string;
  public readonly tokens: JSONPointer;

  constructor(message: string, pointer: string, tokens: JSONPointer) {
    super(message);
    this.name = 'JSONPointerResolutionError';
    this.pointer = pointer;
    this.tokens = tokens;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      pointer: this.pointer,
      tokens: this.tokens,
    };
  }
}

/**
 * Utility functions for common JSON Pointer operations
 */
export const JSONPointerUtils = {
  create: createJSONPointer,
  parse: parseJSONPointer,
  encode: encodeJSONPointerToken,
  decode: decodeJSONPointerToken,
  resolve: resolveJSONPointer,
  fromZodPath: createJSONPointerFromZodPath,
  fromAjvError: createJSONPointerFromAjvError,
  enhanceError: createEnhancedJSONPointerError,
  formatError: formatJSONPointerError,
  multiFormat: createMultiFormatError,
  isValid: isValidJSONPointer,
  normalize: normalizeJSONPointer,
};