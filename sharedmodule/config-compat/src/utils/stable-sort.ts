/**
 * Stable sorting utilities for consistent output across platforms
 */

// Memoization cache for sorting operations
const sortCache = new WeakMap();

/**
 * Recursively sort object keys for stable output
 */
export function stableSortObject(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  // Check cache first
  if (sortCache.has(obj)) {
    return sortCache.get(obj);
  }

  let result: any;

  if (Array.isArray(obj)) {
    // For arrays, only sort if they contain objects (likely configuration objects)
    if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
      result = obj.map(stableSortObject);
    } else {
      // For primitive arrays or empty arrays, just return a copy
      result = [...obj].sort();
    }
  } else {
    const sorted: any = {};
    const keys = Object.keys(obj).sort();

    // Only sort specific keys that need ordering for configuration consistency
    const criticalKeys = ['type', 'id', 'enabled', 'providers', 'routing', 'models'];
    const otherKeys = keys.filter(key => !criticalKeys.includes(key));

    // Process critical keys first for consistent output
    for (const key of criticalKeys.filter(k => keys.includes(k))) {
      sorted[key] = stableSortObject(obj[key]);
    }

    // Process other keys
    for (const key of otherKeys) {
      sorted[key] = stableSortObject(obj[key]);
    }

    result = sorted;
  }

  // Cache the result
  sortCache.set(obj, result);
  return result;
}

/**
 * Sort providers by ID for consistent routing
 */
export function sortProviders(providers: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};
  const providerIds = Object.keys(providers).sort();

  for (const providerId of providerIds) {
    sorted[providerId] = stableSortObject(providers[providerId]);
  }

  return sorted;
}

/**
 * Sort routing configuration by route name
 */
export function sortRouting(routing: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};
  const routeNames = Object.keys(routing).sort();

  for (const routeName of routeNames) {
    sorted[routeName] = Array.isArray(routing[routeName])
      ? [...routing[routeName]].sort()
      : stableSortObject(routing[routeName]);
  }

  return sorted;
}

/**
 * Sort key aliases and auth mappings for consistent output
 */
export function sortKeyMappings(keyMappings: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};

  // Sort main key categories
  const categories = Object.keys(keyMappings).sort();
  for (const category of categories) {
    if (typeof keyMappings[category] === 'object' && keyMappings[category] !== null) {
      sorted[category] = stableSortObject(keyMappings[category]);
    } else {
      sorted[category] = keyMappings[category];
    }
  }

  return sorted;
}