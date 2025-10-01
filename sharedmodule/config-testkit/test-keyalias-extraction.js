#!/usr/bin/env node

// Test keyAliases extraction logic
console.log('=== Testing keyAliases Extraction Logic ===\n');

// Simulate the normalized output structure
const normalized = {
  compatibilityConfig: {
    normalizedConfig: {
      virtualrouter: {
        providers: {
          'openai-provider': {
            keyAliases: ['key1']
          }
        }
      }
    }
  }
};

// Simulate the extraction logic
if (normalized.compatibilityConfig?.normalizedConfig) {
  const normalizedConfig = normalized.compatibilityConfig.normalizedConfig;

  // Extract keyAliases from providers to top level if it exists
  if (normalizedConfig.virtualrouter?.providers) {
    const providerEntries = Object.entries(normalizedConfig.virtualrouter.providers);
    console.log('Provider entries:', providerEntries);

    if (providerEntries.length > 0) {
      const firstProvider = providerEntries[0][1];
      console.log('First provider:', firstProvider);

      if (firstProvider.keyAliases) {
        normalized.keyAliases = firstProvider.keyAliases;
        console.log('Extracted keyAliases:', normalized.keyAliases);
      } else {
        console.log('No keyAliases found in first provider');
      }
    } else {
      console.log('No provider entries found');
    }
  } else {
    console.log('No virtualrouter.providers found');
  }
} else {
  console.log('No compatibilityConfig.normalizedConfig found');
}

console.log('\nFinal normalized object:', JSON.stringify(normalized, null, 2));